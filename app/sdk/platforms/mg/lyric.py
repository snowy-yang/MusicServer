"""咪咕歌词（对应 sdk/mg/lyric.ts）。

resourceinfo.do 取 lrcUrl/lyricUrl 再下载文本；歌词 CDN 只认 y.migu.cn 的 Referer，
与资源接口的 music.migu.cn Referer 不同，所以单独发一次请求。
上游对应 music-lib/migu/lyric.go。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.mg.util import SONG_DETAIL_URL, build_url, migu_get

LRC_REFERER = "https://y.migu.cn/"
LRC_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
)

_HTTP_PREFIX = re.compile(r"^http://")


def content_id_of(song_info: dict[str, Any]) -> str:
    """从 extra.content_id 或 songmid（contentId|resourceType|formatType）取 contentId。"""
    extra = song_info.get("extra") or {}
    if isinstance(extra, dict) and extra.get("content_id"):
        return str(extra["content_id"])
    raw_id = str(song_info.get("songmid") or song_info.get("id") or "")
    return raw_id.split("|")[0]


async def get_lyric(song_info: dict[str, Any]) -> dict[str, str]:
    content_id = content_id_of(song_info)
    if not content_id:
        raise RuntimeError("migu 歌曲 id 无效")
    body = await migu_get(build_url(SONG_DETAIL_URL, {"resourceId": content_id, "resourceType": "2"}))
    resource = body.get("resource") if isinstance(body, dict) else None
    if not resource:
        raise RuntimeError("migu 歌词资源不存在")
    first = resource[0] if isinstance(resource[0], dict) else {}
    lrc_url = str(first.get("lrcUrl") or "") or str(first.get("lyricUrl") or "")
    if not lrc_url:
        return {"lyric": "", "tlyric": ""}
    lrc_url = _HTTP_PREFIX.sub("https://", lrc_url)
    resp = await http_fetch(lrc_url, headers={"User-Agent": LRC_UA, "Referer": LRC_REFERER}, timeout=20_000)
    if resp.status_code != 200:
        raise RuntimeError(f"migu 歌词下载失败 {resp.status_code}")
    return {"lyric": resp.body if isinstance(resp.body, str) else "", "tlyric": ""}
