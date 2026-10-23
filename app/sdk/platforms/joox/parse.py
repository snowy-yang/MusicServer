"""JOOX 链接解析（对应 sdk/joox/parse.ts）。

歌曲：joox.com/<region>/single/<id> 或裸 ID（>10 字符且不含 '/'）→ openjoox2 详情 → Song（含直链）
专辑：joox.com/.../album/<id>、h_activity_id=、albumid= → album.get_album_detail
歌单：joox.com/.../playlist/<id>、playlistid|playlist_id|id= → playlist.get_playlist_detail
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.platforms.joox.album import parse_album as _parse_album
from app.sdk.platforms.joox.music_info import get_track_detail, pick_track_url
from app.sdk.platforms.joox.playlist import parse_playlist as _parse_playlist
from app.sdk.platforms.joox.song import joox_song_from_detail
from app.sdk.platforms.joox.util import normalize_joox_id

_SINGLE_RE = re.compile(r"joox\.com/.*/single/([^/?#]+)")


async def parse_song(link: str) -> dict[str, Any]:
    """歌曲链接 → Song（上游 Parse 的正则与裸 ID 规则）。"""
    raw = str(link or "").strip()
    match = _SINGLE_RE.search(raw)
    if match:
        song_id = normalize_joox_id(match.group(1))
    elif len(raw) > 10 and "/" not in raw:
        song_id = normalize_joox_id(raw)
    else:
        raise RuntimeError("invalid joox link")
    detail = await get_track_detail(song_id)
    return joox_song_from_detail(detail, pick_track_url(detail))


async def parse_album(link: str) -> dict[str, Any]:
    """专辑链接 → 专辑详情（上游 ParseAlbum）。"""
    return await _parse_album(link)


async def parse_playlist(link: str) -> dict[str, Any]:
    """歌单链接 → 歌单详情（上游 ParsePlaylist）。"""
    return await _parse_playlist(link)
