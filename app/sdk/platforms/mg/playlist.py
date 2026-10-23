"""咪咕歌单（对应 sdk/mg/playlist.ts）。

搜索（search_all.do 的 songlist 开关）、曲目（MIGUM3.0 playlist/song/v2.0）、
分类（静态关键词表，上游同款，平台未提供分类接口）、链接解析。
上游对应 music-lib/migu/playlist.go。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.platforms.mg.music_search import search_all
from app.sdk.platforms.mg.util import (
    build_url,
    convert_item_to_song,
    first_non_empty,
    migu_get,
    migu_playlist_link,
    parse_int,
    pick_migu_image,
    to_number,
)

PLAYLIST_SONG_URL = "https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0"

_PLAYLIST_PATTERNS = (
    re.compile(r"playlistId=(\d+)"),
    re.compile(r"musicListId=(\d+)"),
    re.compile(r"(?:playlist|songlist)/(\d+)"),
)

# 静态分类（上游 miguPlaylistCategoryKeywords）
CATEGORY_KEYWORDS: list[dict[str, Any]] = [
    {"name": "华语", "group": "语种", "hot": True},
    {"name": "欧美", "group": "语种", "hot": True},
    {"name": "日语", "group": "语种"},
    {"name": "韩语", "group": "语种"},
    {"name": "粤语", "group": "语种"},
    {"name": "流行", "group": "风格", "hot": True},
    {"name": "摇滚", "group": "风格", "hot": True},
    {"name": "民谣", "group": "风格", "hot": True},
    {"name": "电子", "group": "风格"},
    {"name": "说唱", "group": "风格"},
    {"name": "古风", "group": "风格"},
    {"name": "轻音乐", "group": "风格"},
    {"name": "影视", "group": "场景", "hot": True},
    {"name": "ACG", "group": "场景"},
    {"name": "治愈", "group": "场景"},
    {"name": "运动", "group": "场景"},
    {"name": "学习", "group": "场景"},
    {"name": "睡前", "group": "场景"},
]


def _to_playlist(item: dict[str, Any], category_id: str | None = None) -> dict[str, Any] | None:
    playlist_id = str(item.get("id") or "").strip()
    name = str(item.get("name") or "").strip()
    if not playlist_id or not name:
        return None
    entry: dict[str, Any] = {
        "id": playlist_id,
        "name": name,
        "cover": first_non_empty(item.get("musicListPicUrl"), pick_migu_image(item.get("imgItems"))),
        "trackCount": parse_int(item.get("musicNum")),
        "playCount": parse_int(item.get("playNum")),
        "creator": first_non_empty(item.get("userName"), item.get("ownerName")),
        "link": migu_playlist_link(playlist_id),
        "source": "mg",
    }
    if category_id:
        entry["categoryId"] = category_id
    return entry


async def search_playlist(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """歌单搜索；分类歌单也用同一接口，关键词即分类名。"""
    body = await search_all(keyword, "songlist", page, limit)
    data = body.get("songListResultData") if isinstance(body, dict) else None
    result = (data or {}).get("result") or []
    playlists = [entry for item in result if (entry := _to_playlist(item)) is not None]
    return {"list": playlists, "source": "mg", "page": page, "limit": limit, "total": len(playlists)}


async def get_categories() -> dict[str, Any]:
    return {
        "source": "mg",
        "list": [
            {"id": "", "name": "全部", "group": "全部"},
            *(
                {"id": item["name"], "name": item["name"], "group": item["group"], "hot": bool(item.get("hot"))}
                for item in CATEGORY_KEYWORDS
            ),
        ],
    }


async def get_category_playlists(category_id: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    keyword = str(category_id or "").strip() or "华语"
    found = await search_playlist(keyword, page, limit)
    playlists = [entry for item in found["list"] if (entry := _to_playlist(item, keyword)) is not None]
    return {"list": playlists, "source": "mg", "page": page, "limit": limit}


async def fetch_playlist_songs(playlist_id: str) -> dict[str, Any]:
    """歌单曲目（每页 50 全量翻页 + 去重；上游 GetPlaylistSongs）。"""
    playlist = str(playlist_id or "").strip()
    if not playlist:
        raise RuntimeError("migu 歌单 id 为空")
    page_size = 50
    seen: set[str] = set()
    songs: list[dict[str, Any]] = []
    total_count = 0

    page_no = 1
    while True:
        body = await migu_get(
            build_url(PLAYLIST_SONG_URL, {"pageNo": page_no, "pageSize": page_size, "playlistId": playlist})
        )
        body = body if isinstance(body, dict) else {}
        if body.get("code") and body["code"] != "000000":
            raise RuntimeError(f"migu api error: {body.get('info')} (code {body.get('code')})")
        data = body.get("data") or {}
        song_list = data.get("songList") or []
        if not total_count:
            total_count = int(to_number(data.get("totalCount")))
        if not song_list:
            break

        before = len(songs)
        for item in song_list:
            song = convert_item_to_song(item, True)
            if song is None:
                continue
            key = (
                first_non_empty(
                    song["extra"].get("content_id"), item.get("contentId"), song["songmid"], item.get("copyrightId")
                )
                or f"{song['name']}|{song['singer']}"
            )
            if key in seen:
                continue
            seen.add(key)
            songs.append(song)

        if len(song_list) < page_size:
            break
        if total_count > 0 and len(songs) >= total_count:
            break
        if len(songs) == before:
            break
        page_no += 1

    if not songs:
        raise RuntimeError("migu 歌单没有可播放歌曲")
    return {"songs": songs, "total": total_count or len(songs)}


async def get_playlist_detail(playlist_id: str, page: int = 1, limit: int = 50) -> dict[str, Any]:
    playlist = str(playlist_id or "").strip()
    fetched = await fetch_playlist_songs(playlist)
    songs: list[dict[str, Any]] = fetched["songs"]
    total: int = fetched["total"]
    start = (page - 1) * limit
    return {
        "source": "mg",
        "info": {"name": playlist, "img": songs[0].get("img") or "", "desc": "", "author": ""},
        "list": songs[start : start + limit],
        "page": page,
        "limit": limit,
        "total": total or len(songs),
    }


async def get_playlist_songs(playlist_id: str) -> list[dict[str, Any]]:
    return (await fetch_playlist_songs(playlist_id))["songs"]


async def parse_playlist_link(link: str) -> dict[str, Any]:
    raw = str(link or "")
    for pattern in _PLAYLIST_PATTERNS:
        match = pattern.search(raw)
        if match:
            return await get_playlist_detail(match.group(1))
    if raw and "/" not in raw:
        return await get_playlist_detail(raw)
    raise RuntimeError("无效的咪咕歌单链接")
