"""Apple Music 链接解析（对应 sdk/apple/parse.ts，上游 apple.go Parse / ParseAlbum / ParsePlaylist）。

song:     https://music.apple.com/us/album/<slug>/<albumId>?i=<songId>（?i= 优先）或裸数字 song id
album:    https://music.apple.com/us/album/<slug>/<id> 或裸数字 album id
playlist: https://music.apple.com/us/playlist/<slug>/pl.xxxx 或裸 pl.* id
上游 Parse 会请求歌曲详情（include=lyrics,albums）并填入 preview URL。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.apple.album import parse_album_link
from app.sdk.platforms.apple.playlist import parse_playlist_link
from app.sdk.platforms.apple.util import apple_song_from_catalog, extract_apple_id, fetch_apple_song_resource


async def parse_song(link: str) -> dict[str, Any]:
    """上游 Parse：单曲链接/裸 id → Song（含 previewUrl 试听直链）。"""
    song_id = extract_apple_id(str(link or ""), "song")
    if not song_id:
        raise RuntimeError(f"invalid apple music song link: {link}")
    res = await fetch_apple_song_resource(song_id, "lyrics,albums")
    if not res:
        raise RuntimeError(f"apple song not found: {song_id}")
    return apple_song_from_catalog(res)


async def parse_album(link: str) -> dict[str, Any]:
    return await parse_album_link(link)


async def parse_playlist(link: str) -> dict[str, Any]:
    return await parse_playlist_link(link)
