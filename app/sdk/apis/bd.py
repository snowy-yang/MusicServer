"""千千音乐 取流（对应 sdk/apis/bd.ts）。

通道：`/v1/song/tracklink`（签名 GET）。档位：3000=flac / 320 / 128 / 64(aac)。
实测（2026-10 匿名）：

* 免费曲目（搜索 isVip=0）各档位均返回明文直链 `data.path`（audio0x.dmhmusic.com，CDN 签名 URL）；
* VIP/版权曲目返回 200 / errno 22000 但 `data` 无 path、无 trail_audio_info，
  需登录态会员 cookie 才可能有直链 —— 这类曲目沿降级链走到底后如实报错，不造假数据。

**签名串与实际 query 必须同源**：`sign_params` 一次产出签名与参数，query 由
`URLSearchParams` 等价编码拼好后整串交给 `http_fetch`，不会再被二次序列化。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.bd.util import api_ok, error_text, first_non_empty, num_or_zero, track_link

# 请求档位 → tracklink rate 尝试链（优先请求档，逐级降级；与上游 3000→320→128→64 的探测顺序一致）
QUALITY_RATES: dict[str, list[str]] = {
    "64k": ["64"],
    "128k": ["128", "64"],
    "320k": ["320", "128", "64"],
    "flac": ["3000", "320", "128", "64"],
    "flac24bit": ["3000", "320", "128", "64"],
}
DEFAULT_RATES = ["3000", "320", "128", "64"]

# 千千没有 flac24bit 对外档位（上游只到 3000 = flac）
SUPPORT_QUALITYS: list[str] = ["64k", "128k", "320k", "flac"]


def type_of_hit(request_rate: str, data: Any) -> str:
    """命中档位判定：以响应 format/rate/bits 为准（可能低于请求档位）。"""
    source = data if isinstance(data, dict) else {}
    fmt = str(source.get("format") or "").lower()
    rate = num_or_zero(source.get("rate"))
    bits = num_or_zero(source.get("bits"))
    if fmt == "flac" or rate >= 1000:
        return "flac24bit" if bits == 24 else "flac"
    if rate >= 320 or request_rate == "320":
        return "320k"
    if rate >= 128 or request_rate == "128":
        return "128k"
    return "64k"


async def get_download_url(tsid: str, type: str | None = None) -> dict[str, Any]:
    """逐档请求 tracklink，取首个带 path 的档位。"""
    id = str(tsid if tsid is not None else "").strip()
    if not id:
        raise RuntimeError("千千歌曲 id（TSID）为空")
    rates = QUALITY_RATES.get(str(type if type is not None else ""), DEFAULT_RATES)

    last_err: Exception | None = None
    for rate in rates:
        try:
            body = await track_link(id, rate)
            if not api_ok(body):
                last_err = RuntimeError(error_text(body, "千千取流失败"))
                continue
            data = (body.get("data") if isinstance(body, dict) else None) or {}
            data = data if isinstance(data, dict) else {}
            trail = data.get("trail_audio_info")
            url = first_non_empty(data.get("path"), trail.get("path") if isinstance(trail, dict) else None)
            if url:
                return {"type": type_of_hit(rate, data), "url": url}
            last_err = RuntimeError("千千该歌曲无可用直链（VIP/版权曲目需登录态，免费曲目可直接取流）")
        except Exception as err:  # noqa: BLE001 - 单档网络/上游失败沿降级链继续，与原实现一致
            last_err = err
    if last_err is not None:
        raise last_err
    raise RuntimeError("千千未找到可用音频直链")


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    # 上游 GetDownloadURL：Song.URL 已有直链时直接复用（Parse 场景）
    if song_info.get("url"):
        return {"type": quality or "128k", "url": str(song_info["url"])}
    tsid = first_non_empty(song_info.get("songmid"), song_info.get("TSID"))
    if not tsid:
        raise RuntimeError("千千歌曲 id（TSID）为空")
    return await get_download_url(tsid, quality)
