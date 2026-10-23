"""千千音乐链接解析（对应 sdk/bd/parse.ts）。

歌曲：`music.91q.com/song/<TSID>`（上游 Parse：取 song/info 后顺带取直链，失败不影响返回）。
专辑：`music.91q.com/album/<P码>` / `?albumAssetCode=` / `?albumid=`。
歌单：`music.91q.com/songlist|tracklist|playlist/<id>` / `?*id=` / 裸歌单 id。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.platforms.bd import album as album_module
from app.sdk.platforms.bd import playlist as playlist_module
from app.sdk.platforms.bd.music_info import get_song_info
from app.sdk.platforms.bd.util import first_non_empty

_TSID_RE = re.compile(r"music\.91q\.com/song/(\w+)", re.ASCII)


async def parse_song(link: str) -> dict[str, Any]:
    """上游 Parse：歌曲链接 → Song（尽力附带直链 url/type）。"""
    match = _TSID_RE.search(str(link if link is not None else ""))
    if not match:
        raise RuntimeError("无效的千千歌曲链接")
    tsid = match.group(1)

    song: dict[str, Any] = dict(await get_song_info(tsid))
    try:
        # 延迟导入：`apis/bd.py` 依赖本包的 util，顶层导入会让包初始化与 apis 互等
        from app.sdk.apis.bd import get_download_url

        hit = await get_download_url(tsid)
        song["url"] = hit["url"]
        song["type"] = hit["type"]
    except Exception:  # noqa: BLE001 - 与上游一致：直链获取失败忽略（VIP/下架曲目仍返回元数据）
        pass
    song.pop("lyricUrl", None)
    song.pop("raw", None)
    return {**song, "songmid": first_non_empty(song.get("songmid"), tsid), "source": "bd"}


async def parse_album(link: str) -> dict[str, Any]:
    return await album_module.parse_album_link(link)


async def parse_playlist(link: str) -> dict[str, Any]:
    return await playlist_module.parse_playlist_link(link)
