"""千千音乐歌词（对应 sdk/bd/lyric.ts）。

链路：`/v1/song/info` → `data[0].lyric` 为歌词文本 URL（static-qianqian.taihe.com/*.txt）
→ 直接下载文本。返回 `{lyric, tlyric: ''}`（千千只有原文歌词，无翻译）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.bd.music_info import get_song_info
from app.sdk.platforms.bd.util import request_headers


async def get_lyric(song_info: dict[str, Any]) -> dict[str, Any]:
    tsid = str(song_info.get("songmid") or song_info.get("TSID") or "").strip()
    if not tsid:
        raise RuntimeError("千千歌词需要 songmid（TSID）")

    info = await get_song_info(tsid)
    lyric_url = str(info.get("lyricUrl") or "").strip()
    if not lyric_url:
        raise RuntimeError("千千该歌曲暂无歌词")

    resp = await http_fetch(lyric_url, method="get", headers=request_headers(), timeout=15000)
    if resp.status_code != 200:
        raise RuntimeError(f"千千歌词下载失败（HTTP {resp.status_code}）")
    lyric = resp.body if isinstance(resp.body, str) else resp.raw.decode("utf-8", errors="replace")
    return {"lyric": lyric, "tlyric": ""}
