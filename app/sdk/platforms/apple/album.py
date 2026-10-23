"""Apple Music 专辑（对应 sdk/apple/album.ts，上游 apple.go 的 SearchAlbum / ParseAlbum / GetAlbumSongs）。

详情：amp-api /v1/catalog/<sf>/albums/<id>?extend=extendedAssetUrls
  → data[0].relationships.tracks.data[]（>300 首时分页，next 由 fetchAllTrackResources 跟进）
链接：extract_apple_id(link, 'album')，支持裸数字 id 与 /us/album/<slug>/<id> 链接。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.utils import as_dict, as_list
from app.sdk.platforms.apple.music_search import search_album
from app.sdk.platforms.apple.util import (
    apple_album_to_playlist,
    apple_amp_get,
    apple_song_from_catalog,
    extract_apple_id,
    fetch_all_track_resources,
    get_apple_config,
)


async def get_album_detail(raw_id: str, page: int = 1, limit: int = 50) -> dict[str, Any]:
    """专辑详情（page/limit 在完整曲目上切片，与其它平台 get_album_detail 契约一致）。"""
    album_id = extract_apple_id(str(raw_id or ""), "album")
    if not album_id:
        raise RuntimeError(f"invalid apple music album id/link: {raw_id}")

    cfg = get_apple_config()
    body = as_dict(
        await apple_amp_get(f"/v1/catalog/{cfg['storefront']}/albums/{album_id}", {"extend": "extendedAssetUrls"})
    )
    data = as_list(body.get("data"))
    album = as_dict(data[0]) if data else {}
    if not album:
        raise RuntimeError(f"apple album not found: {album_id}")

    tracks = await fetch_all_track_resources(as_dict(album.get("relationships")).get("tracks"))
    songs = [apple_song_from_catalog(track, album_id) for track in tracks]

    p = max(1, int(page or 1))
    size = max(1, int(limit or 50))
    summary = apple_album_to_playlist(album)
    # 上游 fetchPlaylistDetail 的做法：接口未给 trackCount 时以实际曲目数补齐
    if not summary["trackCount"] or len(songs) > summary["trackCount"]:
        summary["trackCount"] = len(songs)

    return {
        "source": "apple",
        "info": {
            "id": album_id,
            "name": summary["name"],
            "img": summary["cover"],
            "desc": summary["description"],
            "author": summary["creator"],
            "link": summary["link"],
            "trackCount": summary["trackCount"],
            "releaseDate": summary["extra"]["release_date"],
            "recordLabel": summary["extra"]["record_label"],
        },
        "list": songs[(p - 1) * size : (p - 1) * size + size],
        "page": p,
        "limit": size,
        "total": len(songs),
    }


async def get_album_songs(album_id: str) -> list[dict[str, Any]]:
    """上游 GetAlbumSongs：只返回曲目数组。"""
    detail = await get_album_detail(album_id, 1, 100000)
    return detail["list"]


async def parse_album_link(link: str) -> dict[str, Any]:
    """上游 ParseAlbum：专辑链接 → 详情（曲目全量，不分页）。"""
    detail = await get_album_detail(link, 1, 100000)
    return {
        "source": "apple",
        "id": detail["info"]["id"],
        "info": detail["info"],
        "list": detail["list"],
        "page": 1,
        "limit": max(detail["total"], 1),
        "total": detail["total"],
    }


__all__ = ["get_album_detail", "get_album_songs", "parse_album_link", "search_album"]
