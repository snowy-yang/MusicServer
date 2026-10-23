"""Apple Music 歌单（对应 sdk/apple/playlist.ts，上游 apple.go 的歌单相关接口）。

详情：amp-api /v1/catalog/<sf>/playlists/<id>?limit[tracks]=300&extend=extendedAssetUrls
  曲目超过一页时沿 relationships.tracks.next 全量拉取（带 20 页上限防死循环）。
分类：上游使用写死的 Apple Music genre curator 列表（appleCuratorCategories），
  GetCategoryPlaylists 固定 storefront=cn + l=zh-Hans-CN（curator id 取自 cn 区）。
链接：extract_apple_id(link, 'playlist')，支持 pl.* 裸 id 与 /us/playlist/<slug>/pl.* 链接。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.utils import as_dict, as_list
from app.sdk.platforms.apple.music_search import search_playlist
from app.sdk.platforms.apple.util import (
    apple_amp_get,
    apple_playlist_to_playlist,
    apple_song_from_catalog,
    extract_apple_id,
    fetch_all_track_resources,
    get_apple_config,
)

#: 上游 appleCuratorCategories（从公开搜索落地页提取的 Apple Music genre curators）
APPLE_CURATOR_CATEGORIES: list[dict[str, str]] = [
    {"id": "1526756058", "name": "热门"},
    {"id": "1479949880", "name": "C-Pop"},
    {"id": "1019400042", "name": "国语流行"},
    {"id": "1019398918", "name": "粤语流行"},
    {"id": "1019399540", "name": "国际流行"},
    {"id": "1019399551", "name": "K-Pop"},
    {"id": "1019399547", "name": "J-Pop"},
    {"id": "989061415", "name": "嘻哈/说唱"},
    {"id": "1019400044", "name": "R&B"},
    {"id": "1019400046", "name": "摇滚"},
    {"id": "1019397973", "name": "另类音乐"},
    {"id": "976439535", "name": "舞曲"},
    {"id": "976439536", "name": "电子"},
    {"id": "976439541", "name": "独立音乐"},
    {"id": "1019399549", "name": "爵士乐"},
    {"id": "1019398924", "name": "古典音乐"},
    {"id": "976439528", "name": "蓝调"},
    {"id": "976439534", "name": "乡村音乐"},
    {"id": "1531542847", "name": "拉丁音乐"},
    {"id": "988656348", "name": "非洲音乐"},
    {"id": "976439543", "name": "金属乐"},
    {"id": "976439550", "name": "朋克乐"},
    {"id": "1019400049", "name": "不插电"},
    {"id": "1231181168", "name": "影视原声"},
    {"id": "1441811365", "name": "DJ 混音精选"},
    {"id": "1532467784", "name": "瞩目之星"},
    {"id": "1554938339", "name": "年代之声"},
    {"id": "1564180390", "name": "空间音频"},
    {"id": "989010186", "name": "亲子"},
]


async def get_categories() -> dict[str, Any]:
    """上游 GetPlaylistCategories：静态返回 Apple Music genre curators。"""
    return {
        "source": "apple",
        "list": [
            {"id": item["id"], "name": item["name"], "group": "Apple Music 分类", "source": "apple"}
            for item in APPLE_CURATOR_CATEGORIES
        ],
    }


async def get_category_playlists(category_id: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """上游 GetCategoryPlaylists：按 curator 分类取歌单（cn storefront，单请求上限 25，循环补齐）。"""
    cate = str(category_id or "").strip()
    if not cate:
        raise RuntimeError("apple 分类 id 不能为空")
    p = max(1, int(page or 1))
    size = min(max(1, int(limit or 20)), 300)
    api_max = 25
    offset = (p - 1) * size
    all_playlists: list[dict[str, Any]] = []

    while len(all_playlists) < size:
        batch_size = min(api_max, size - len(all_playlists))
        try:
            body = as_dict(
                await apple_amp_get(
                    f"/v1/catalog/cn/apple-curators/{cate}/playlists",
                    {"limit": batch_size, "offset": offset, "l": "zh-Hans-CN"},
                )
            )
        except Exception:  # 上游：已有数据时返回已取部分
            if all_playlists:
                break
            raise
        data = as_list(body.get("data"))
        all_playlists.extend(apple_playlist_to_playlist(item) for item in data)
        # 没有更多数据或没有下一页
        if len(data) < batch_size or not body.get("next"):
            break
        offset += len(data)

    return {"source": "apple", "list": all_playlists[:size], "page": p, "limit": size, "total": len(all_playlists)}


async def get_playlist_detail(raw_id: str, page: int = 1, limit: int = 100) -> dict[str, Any]:
    """歌单详情（全量曲目后按 page/limit 切片）。"""
    playlist_id = extract_apple_id(str(raw_id or ""), "playlist")
    if not playlist_id:
        raise RuntimeError(f"invalid apple music playlist id/link: {raw_id}")

    cfg = get_apple_config()
    body = as_dict(
        await apple_amp_get(
            f"/v1/catalog/{cfg['storefront']}/playlists/{playlist_id}",
            {"limit[tracks]": 300, "extend": "extendedAssetUrls"},
        )
    )
    data = as_list(body.get("data"))
    item = as_dict(data[0]) if data else {}
    if not item:
        raise RuntimeError(f"apple playlist not found: {playlist_id}")

    tracks = await fetch_all_track_resources(as_dict(item.get("relationships")).get("tracks"))
    songs = [apple_song_from_catalog(track) for track in tracks]

    p = max(1, int(page or 1))
    size = max(1, int(limit or 100))
    summary = apple_playlist_to_playlist(item)
    if not summary["trackCount"] or len(songs) > summary["trackCount"]:
        summary["trackCount"] = len(songs)

    return {
        "source": "apple",
        "info": {
            "id": playlist_id,
            "name": summary["name"],
            "img": summary["cover"],
            "desc": summary["description"],
            "author": summary["creator"],
            "link": summary["link"],
            "trackCount": summary["trackCount"],
        },
        "list": songs[(p - 1) * size : (p - 1) * size + size],
        "page": p,
        "limit": size,
        "total": len(songs),
    }


async def get_playlist_songs(playlist_id: str) -> list[dict[str, Any]]:
    """上游 GetPlaylistSongs：只返回曲目数组。"""
    detail = await get_playlist_detail(playlist_id, 1, 100000)
    return detail["list"]


async def parse_playlist_link(link: str) -> dict[str, Any]:
    """上游 ParsePlaylist：歌单链接 → 详情（曲目全量，不分页）。"""
    detail = await get_playlist_detail(link, 1, 100000)
    return {
        "source": "apple",
        "id": detail["info"]["id"],
        "info": detail["info"],
        "list": detail["list"],
        "page": 1,
        "limit": max(detail["total"], 1),
        "total": detail["total"],
    }


__all__ = [
    "APPLE_CURATOR_CATEGORIES",
    "get_categories",
    "get_category_playlists",
    "get_playlist_detail",
    "get_playlist_songs",
    "parse_playlist_link",
    "search_playlist",
]
