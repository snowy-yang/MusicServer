"""5sing 歌曲信息 / 取流底层（对应 sdk/5sing/musicInfo.ts）。

链路（上游 fivesing/fivesing.go 的 fetchSongInfo / fetchAudioLink）：
  取流: GET {MOBILE_API}/song/getSongUrl?songid=&songtype=  → data.{sq,hq,lq}url(_backup)，code 必须 1000
  详情: GET {MOBILE_API}/song/newget?songid=&songtype=      → data.SN / data.user.NN / data.user.I / data.dynamicWords

档位字段：squrl（无损/高码）→ hqurl（高）→ lqurl（低），每档有 _backup 备用地址；
上游固定 sq→hq→lq；本移植按请求档位微调（请求 64k/lq 时倒序），返回实际命中档位。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.utils import as_dict
from app.sdk.platforms.fivesing.util import (
    MOBILE_API,
    build_song_link,
    encode_uri_component,
    estimate_duration,
    fetch_5sing_json,
    get_first_valid,
    kind_name,
)

QUALITY_TIERS = ("sq", "hq", "lq")


def _tier_url(data: dict[str, Any], tier: str) -> str:
    """data 里某档位的可用地址（主地址 → backup）。"""
    return get_first_valid(data.get(f"{tier}url"), data.get(f"{tier}url_backup"))


async def fetch_audio_link(song_id: str, song_type: str, prefer_low: bool = False) -> dict[str, str]:
    """上游 fetchAudioLink：仅获取音频链接。"""
    url = (
        f"{MOBILE_API}/song/getSongUrl?songid={encode_uri_component(song_id)}"
        f"&songtype={encode_uri_component(song_type)}"
    )
    resp = await fetch_5sing_json(url)
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or not isinstance(resp.body, dict):
        raise RuntimeError(f"5sing 取流失败（HTTP {resp.status_code}）")
    try:
        code = int(body.get("code") or 0)
    except (TypeError, ValueError):
        code = 0
    if code != 1000:
        # 实测 songtype 缺失/错误时 code=28 message=歌曲不存在
        message = body.get("message")
        raise RuntimeError(f"5sing 取流失败（{message}）" if message else "api returned error code")

    data = as_dict(body.get("data"))
    order = tuple(reversed(QUALITY_TIERS)) if prefer_low else QUALITY_TIERS
    for tier in order:
        hit = _tier_url(data, tier)
        if hit and hit.startswith(("http://", "https://")):
            return {"type": tier, "url": hit}
    raise RuntimeError("no valid download url found")


async def fetch_new_get(song_id: str, song_type: str) -> dict[str, Any]:
    """上游 fetchSongInfo / GetLyrics 使用的 newget 详情（返回 data 对象）。"""
    url = f"{MOBILE_API}/song/newget?songid={encode_uri_component(song_id)}&songtype={encode_uri_component(song_type)}"
    resp = await fetch_5sing_json(url)
    if resp.status_code != 200 or not isinstance(resp.body, dict):
        raise RuntimeError(f"5sing 歌曲信息获取失败（HTTP {resp.status_code}）")
    data = resp.body.get("data")
    return data if isinstance(data, dict) else {}


async def fetch_dynamic_lyric(song_id: str, song_type: str) -> str:
    """上游 newget 歌词：data.dynamicWords（LRC 文本）。"""
    data = await fetch_new_get(song_id, song_type)
    return str(data.get("dynamicWords") or "")


async def fetch_song_info(song_id: str, song_type: str) -> dict[str, Any]:
    """上游 fetchSongInfo：音频直链 + newget 元数据 → 统一 Song 形状。"""
    hit = await fetch_audio_link(song_id, song_type)

    name = ""
    artist = ""
    cover = ""
    try:
        data = await fetch_new_get(song_id, song_type)
        name = str(data.get("SN") or "")
        user = as_dict(data.get("user"))
        artist = str(user.get("NN") or "")
        cover = str(user.get("I") or "")
    except Exception:  # noqa: BLE001 - 上游 newget 失败时继续（不阻断）
        pass
    if not name:
        name = f"5sing_{song_type}_{song_id}"

    return {
        "songmid": f"{song_id}|{song_type}",
        "name": name,
        "singer": artist,
        "albumId": "",
        "albumName": "",
        "interval": 0,
        "img": cover or None,
        "lrc": None,
        "types": [],
        "_types": {},
        "url": hit["url"],
        "type": hit["type"],
        "link": build_song_link(song_type, song_id),
        "songType": song_type,
        "typeName": kind_name(song_type),
        "source": "5sing",
    }


def song_interval(song_size: Any) -> int:
    """时长估算的对外小工具（搜索结果用；上游 Search 的 Duration 公式）。"""
    return estimate_duration(song_size)
