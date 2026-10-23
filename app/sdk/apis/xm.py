"""喜马拉雅 URL 获取（对应 sdk/apis/xm.ts，PC 桌面端 baseInfo 通道）。

链路：make_xm_sign(hdaa 上报) → baseInfo device=win(带 PC 设备 Cookie) → playUrlList
  → decode_win_url(AES-ECB，客户端 4.0.14 asar 密钥) → a.xmcdn.com 带签名直链。

实测（2026-10-02）匿名免费曲目 HTTP 200 audio/mp4 可播；付费/VIP 曲 ret=1001（需登录）。
档位命名如 M4A_64/MP3_64/M4A_24/MP3_32/AAC_24（音乐内容另有 MP3_128/M4A_128）；
喜马拉雅以有声内容为主，码率低于音乐平台，音质映射到 '64k'/'128k' 桶。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.platforms.xm.decoder import decode_win_url
from app.sdk.platforms.xm.music_info import get_track_info, play_url_list

#: 优先 M4A（同码率体积更小），128 档优先 MP3_128
QUALITY_PREFERENCE: dict[str, list[str]] = {
    "128k": ["MP3_128", "M4A_128", "M4A_64", "MP3_64", "M4A_24", "MP3_32", "AAC_24"],
    "64k": ["M4A_64", "MP3_64", "M4A_24", "MP3_32", "AAC_24"],
}
SUPPORT_QUALITYS: list[str] = ["64k", "128k"]


def _bitrate_of(type_name: str) -> int:
    match = re.search(r"(\d+)", str(type_name or ""))
    return int(match.group(1)) if match else 0


def _bucket_of(bitrate: int) -> str:
    return "128k" if bitrate >= 128 else "64k"


def _resolve_url(raw: str) -> str:
    return raw if raw.startswith("http") else decode_win_url(raw)


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """取流：按档位偏好找 playUrlList，未知命名时取码率最高的一条。"""
    del retry_num  # 契约参数，无重试语义
    track_id = str(song_info.get("songmid") or "")
    track_info = await get_track_info(track_id)
    play_list = play_url_list(track_info)
    if not play_list:
        raise RuntimeError("无可用播放资源（付费/版权内容需登录）")

    preference = QUALITY_PREFERENCE.get(quality, QUALITY_PREFERENCE["128k"])
    picked: dict[str, str] | None = None
    for want in preference:
        hit = next((item for item in play_list if item.get("type") == want and item.get("url")), None)
        if hit:
            picked = {"type": str(hit["type"]), "url": _resolve_url(str(hit["url"]))}
            break
    if picked is None:
        # 兜底：未知档位命名时取码率最高的一条
        candidates = [item for item in play_list if item.get("url")]
        if not candidates:
            raise RuntimeError("无可用播放资源")
        best = sorted(candidates, key=lambda item: _bitrate_of(str(item.get("type") or "")), reverse=True)[0]
        picked = {"type": str(best["type"]), "url": _resolve_url(str(best["url"]))}
    return {"type": _bucket_of(_bitrate_of(picked["type"])), "url": picked["url"]}
