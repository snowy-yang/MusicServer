"""5sing 链接解析（对应 sdk/5sing/parse.ts）。

歌曲: 5sing.kugou.com/(yc|fc|bz)/<数字id>.html → fetch_song_info（直链 + newget 元数据，无直链即报错）
歌单: /{userId}/dj/<id>.html → getPlaylistDetail 全量曲目（支持个性域名 userId）
专辑: 上游无专辑概念（不实现）
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.fivesing.music_info import fetch_song_info
from app.sdk.platforms.fivesing.playlist import parse_playlist_link
from app.sdk.platforms.fivesing.util import extract_song_link


async def parse_song(link: str) -> dict[str, Any]:
    parsed = extract_song_link(link)
    if not parsed:
        raise RuntimeError("invalid 5sing link")
    return await fetch_song_info(parsed["songID"], parsed["songType"])


async def parse_playlist(link: str) -> dict[str, Any]:
    return await parse_playlist_link(link)
