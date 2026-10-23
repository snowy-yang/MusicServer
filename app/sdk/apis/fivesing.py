"""5sing 取流（对应 sdk/apis/5sing.ts，上游 fivesing/download.go 的 GetDownloadURL）。

链路：GET http://mobileapi.5sing.kugou.com/song/getSongUrl?songid=<id>&songtype=<yc|fc|bz>
  → { code: 1000, data: { squrl/squrl_backup, hqurl/hqurl_backup, lqurl/lqurl_backup, ... } }
  直链为 CDN 明文地址（wsaudiobssdlbig.kugou.com，https，无需 Referer/防盗链签名；实测 Range 206 可播）。

档位：上游固定 sq（最高）→ hq → lq，返回首个非空（含 _backup）；只有显式请求 64k（或 lq）时
才倒序优先 lq，返回实际命中档位。songmid 约定 ``<songId>|<songType>``；
Parse 出来的歌曲带 url 时直接复用（上游 GetDownloadURL: if s.URL != "" return）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.fivesing.music_info import fetch_audio_link
from app.sdk.platforms.fivesing.util import extract_song_id, is_foreign_source

#: 上游只有 sq/hq/lq 三档，实际命中档位以返回 type 为准（sq 常缺，多命中 hq）
SUPPORT_QUALITYS: list[str] = ["sq", "hq", "lq"]


async def get_download_url(song_info: dict[str, Any], quality: str | None = None) -> dict[str, str]:
    """上游 GetDownloadURL 的等价实现。"""
    if is_foreign_source(song_info):
        raise RuntimeError("source mismatch")
    # 上游逻辑：Song.URL 已带直链（Parse 场景）直接复用
    if song_info.get("url"):
        return {"type": str(song_info.get("type") or quality or "sq"), "url": str(song_info["url"])}
    ids = extract_song_id(
        song_info.get("songmid") or song_info.get("id") or song_info.get("songid"), song_info.get("songType")
    )
    if not ids["songID"] or not ids["songType"]:
        raise RuntimeError('invalid id structure: 5sing songmid 需为 "<songId>|<songType>"（songType 为 yc/fc/bz）')
    prefer_low = quality in ("64k", "lq")
    return await fetch_audio_link(ids["songID"], ids["songType"], prefer_low)


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """统一取流：返回 ``{type: 'sq'|'hq'|'lq', url}``（type 为实际命中档位，可能低于请求档位）。"""
    del retry_num  # 契约参数，重试已在 fetch_5sing_json 内
    hit = await get_download_url(song_info, quality)
    return {"type": hit["type"], "url": hit["url"]}
