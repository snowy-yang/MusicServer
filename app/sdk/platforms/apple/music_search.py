"""Apple Music 搜索（对应 sdk/apple/musicSearch.ts，上游 apple.go 的 Search / SearchAlbum / SearchPlaylist）。

通道：amp-api /v1/catalog/<storefront>/search（Bearer developer token，见 util.py）
单次请求上限 25 条，page/limit 用 offset 翻页；响应没有 total，
因此 total = 已翻过的条数 + 本页条数（下一页是否存在由 next 决定，allPage=页码+1）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.utils import as_dict, as_list
from app.sdk.platforms.apple.util import (
    apple_album_to_playlist,
    apple_amp_get,
    apple_playlist_to_playlist,
    apple_song_from_catalog,
    get_apple_config,
)

#: amp-api search 单页硬上限
SEARCH_PAGE_MAX = 25


async def _catalog_search(keyword: str, types: str, page: int, limit: int) -> dict[str, Any]:
    word = str(keyword or "").strip()
    p = max(1, int(page or 1))
    size = min(max(1, int(limit or 20)), 100)
    if not word:
        return {"body": None, "page": p, "limit": size}
    cfg = get_apple_config()
    body = await apple_amp_get(
        f"/v1/catalog/{cfg['storefront']}/search",
        {
            "term": word,
            "types": types,
            "limit": min(size, SEARCH_PAGE_MAX),
            "offset": (p - 1) * size,
        },
    )
    return {"body": body, "page": p, "limit": size}


async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    del retry_num  # 契约参数，amp-api 无重试语义
    result = await _catalog_search(keyword, "songs", page, limit)
    p, size = result["page"], result["limit"]
    results = as_dict(as_dict(result["body"]).get("results"))
    bucket = as_dict(results.get("songs"))
    songs = [apple_song_from_catalog(item) for item in as_list(bucket.get("data"))]
    has_next = bool(bucket.get("next"))
    return {
        "list": songs,
        "allPage": p + 1 if has_next else p,
        "total": (p - 1) * size + len(songs),
        "limit": size,
        "source": "apple",
    }


async def search_album(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """上游 SearchAlbum：搜索专辑（返回歌单摘要形状）。"""
    result = await _catalog_search(keyword, "albums", page, limit)
    p, size = result["page"], result["limit"]
    results = as_dict(as_dict(result["body"]).get("results"))
    items = as_list(as_dict(results.get("albums")).get("data"))
    songs = [apple_album_to_playlist(item) for item in items]
    return {
        "list": songs,
        "total": (p - 1) * size + len(songs),
        "page": p,
        "limit": size,
        "source": "apple",
    }


async def search_playlist(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """上游 SearchPlaylist：搜索歌单。"""
    result = await _catalog_search(keyword, "playlists", page, limit)
    p, size = result["page"], result["limit"]
    results = as_dict(as_dict(result["body"]).get("results"))
    items = as_list(as_dict(results.get("playlists")).get("data"))
    playlists = [apple_playlist_to_playlist(item) for item in items]
    return {
        "list": playlists,
        "total": (p - 1) * size + len(playlists),
        "page": p,
        "limit": size,
        "source": "apple",
    }
