"""咪咕链接解析（对应 sdk/mg/index.ts 的 parseSong）。

歌曲：`https://music.migu.cn/v3/music/song/<contentId>` 或裸 contentId（6 位以上数字）。
专辑/歌单分别复用 album / playlist 的链接解析。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.platforms.mg.album import parse_album_link
from app.sdk.platforms.mg.playlist import parse_playlist_link
from app.sdk.platforms.mg.util import convert_item_to_song, fetch_song_detail

_SONG_PATTERNS = (
    re.compile(r"music\.migu\.cn/v3/music/song/(\d+)"),
    re.compile(r"^(\d{6,})$"),
)


async def parse_song(link: str) -> dict[str, Any]:
    raw = str(link or "")
    content_id = ""
    for pattern in _SONG_PATTERNS:
        match = pattern.search(raw)
        if match:
            content_id = match.group(1)
            break
    if not content_id:
        raise RuntimeError("无效的咪咕歌曲链接")
    item = await fetch_song_detail(content_id)
    song = convert_item_to_song(item, True)
    if song is None:
        raise RuntimeError("该歌曲没有可用格式")
    return song


async def parse_album(link: str) -> dict[str, Any]:
    return await parse_album_link(link)


async def parse_playlist(link: str) -> dict[str, Any]:
    return await parse_playlist_link(link)
