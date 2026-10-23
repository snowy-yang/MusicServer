"""千千音乐歌单（对应 sdk/bd/playlist.ts）。

详情：`/v1/tracklist/info?id=&type=0&pageNo=&pageSize=`（支持分页，默认 pageSize=20）。
分类：`/v1/tracklist/category`（group.categoryName + subCate[]）。
分类歌单：`/v1/tracklist/list?subCateId=&pageNo=&pageSize=`（不传 subCateId 为全部）。
搜索：上游用 `/v1/search?type=6`，但 2026-10 实测服务端已下线该搜索类型
  （errno 23001 "不被支持的搜索类型(10000)"），官网搜索页也只有 单曲/歌手/专辑 三个 tab。
  上游在 !state 时静默返回空列表，本实现保持一致并保留 typeSonglist 解析以备恢复。
"""

from __future__ import annotations

import math
import re
from typing import Any

from app.sdk.platforms.bd.util import (
    APP_ID,
    api_get,
    api_ok,
    error_text,
    first_non_empty,
    map_track,
    playlist_link,
    to_int,
)


def _map_playlist_summary(item: Any) -> dict[str, Any]:
    source = item if isinstance(item, dict) else {}
    id = "" if source.get("id") is None else str(source.get("id"))
    raw_desc = str(source.get("desc") or "").strip()
    tag_list = source.get("tagList")
    tags = [str(tag) for tag in tag_list] if isinstance(tag_list, list) else []
    return {
        "id": id,
        "name": str(source.get("title") or "").strip(),
        "cover": str(source.get("pic") or "").strip(),
        "trackCount": to_int(source.get("trackCount"), 0),
        "creator": first_non_empty(
            source.get("creator"),
            source.get("author"),
            source.get("userName"),
            source.get("nickName"),
            source.get("ownerName"),
        ),
        "description": raw_desc or "、".join(tags),
        "link": playlist_link(id) if id else "",
        "source": "bd",
    }


async def search_playlist(keyword: str, page: int = 1, limit: int = 10) -> dict[str, Any]:
    """上游 SearchPlaylist（type=6 歌单搜索；服务端已停用，返回空列表）。"""
    word = str(keyword if keyword is not None else "").strip()
    empty: dict[str, Any] = {"source": "bd", "list": [], "total": 0, "page": page, "limit": limit}
    if not word:
        return empty

    body = await api_get(
        "/v1/search",
        {"word": word, "type": "6", "pageNo": str(page), "pageSize": str(limit), "appid": APP_ID},
    )
    # 上游此处只看 body.state（不看 errno），与服务端下线后的行为一致
    if not isinstance(body, dict) or not body.get("state"):
        return empty

    data = body.get("data") or {}
    items = data.get("typeSonglist") if isinstance(data, dict) else None
    summaries = [_map_playlist_summary(item) for item in items] if isinstance(items, list) else []
    list_out = [item for item in summaries if item["id"]]
    total = to_int(data.get("total") if isinstance(data, dict) else None, len(list_out))
    return {"source": "bd", "list": list_out, "total": total, "page": page, "limit": limit}


async def get_playlist_detail(id: str, page: int = 1, limit: int = 50) -> dict[str, Any]:
    """歌单详情（含曲目；tracklist/info 支持 pageNo/pageSize）。"""
    playlist_id = str(id if id is not None else "").strip()
    if not playlist_id:
        raise RuntimeError("千千歌单 id 为空")

    body = await api_get(
        "/v1/tracklist/info",
        {
            "id": playlist_id,
            "type": "0",
            "pageNo": str(max(1, page)),
            "pageSize": str(max(1, limit)),
            "appid": APP_ID,
        },
    )
    if not api_ok(body):
        raise RuntimeError(error_text(body, "千千歌单获取失败"))

    data = (body.get("data") if isinstance(body, dict) else None) or {}
    data = data if isinstance(data, dict) else {}
    raw_tracks = data.get("trackList")
    tracks = [item for item in raw_tracks if isinstance(item, dict)] if isinstance(raw_tracks, list) else []
    songs = [song for song in (map_track(item) for item in tracks) if song["songmid"]]

    title = first_non_empty(data.get("title"), playlist_id)
    tag_list = data.get("tagList")
    tags = [str(tag) for tag in tag_list] if isinstance(tag_list, list) else []
    cover = first_non_empty(data.get("pic"), songs[0]["img"] if songs else None)
    creator = first_non_empty(
        data.get("creator"),
        data.get("author"),
        data.get("userName"),
        data.get("nickName"),
        data.get("ownerName"),
    )
    description = first_non_empty(data.get("desc"), data.get("description")) or "、".join(tags)
    total = to_int(data.get("trackCount"), len(songs))

    return {
        "source": "bd",
        "info": {
            "id": playlist_id,
            "name": title,
            "img": cover,
            "desc": description,
            "author": creator,
            "link": playlist_link(playlist_id),
        },
        "list": songs,
        "page": page,
        "limit": limit,
        "total": total,
        "allPage": math.ceil(total / max(1, limit)) or 1,
    }


async def get_playlist_songs(id: str) -> list[dict[str, Any]]:
    """上游 GetPlaylistSongs：只取曲目列表。"""
    detail = await get_playlist_detail(id, 1, 1000)
    return detail["list"]


async def get_categories() -> dict[str, Any]:
    """上游 GetPlaylistCategories：`{source, list: [{id, name, group, count}]}`，首项为「全部」（id=''）。"""
    body = await api_get("/v1/tracklist/category", {"appid": APP_ID})
    if not api_ok(body):
        raise RuntimeError(error_text(body, "千千歌单分类获取失败"))

    list_out: list[dict[str, Any]] = [{"id": "", "name": "全部", "group": "全部"}]
    groups = body.get("data") if isinstance(body, dict) else None
    for group in groups if isinstance(groups, list) else []:
        if not isinstance(group, dict):
            continue
        group_name = str(group.get("categoryName") or "").strip()
        sub_cate = group.get("subCate")
        for item in sub_cate if isinstance(sub_cate, list) else []:
            if not isinstance(item, dict):
                continue
            id = str(item.get("id") or "").strip()
            name = str(item.get("categoryName") or "").strip()
            if not id or not name:
                continue
            list_out.append({"id": id, "name": name, "group": group_name, "count": to_int(item.get("count"), 0)})
    return {"source": "bd", "list": list_out}


async def get_category_playlists(category_id: Any, page: int = 1, limit: int = 30) -> dict[str, Any]:
    """上游 GetCategoryPlaylists（page >= 1，limit 1..100）。"""
    cate_id = str(category_id if category_id is not None else "").strip()
    page_no = max(1, to_int(page, 1))
    page_size = min(100, max(1, to_int(limit, 30)))

    params: dict[str, Any] = {"appid": APP_ID, "pageNo": str(page_no), "pageSize": str(page_size)}
    if cate_id:
        params["subCateId"] = cate_id

    body = await api_get("/v1/tracklist/list", params)
    if not api_ok(body):
        raise RuntimeError(error_text(body, "千千分类歌单获取失败"))

    data = (body.get("data") if isinstance(body, dict) else None) or {}
    data = data if isinstance(data, dict) else {}
    result = data.get("result")
    summaries = (
        [{**_map_playlist_summary(item), "categoryId": cate_id} for item in result] if isinstance(result, list) else []
    )
    list_out = [item for item in summaries if item["id"]]
    total = to_int(data.get("total"), len(list_out))
    return {"source": "bd", "list": list_out, "total": total, "page": page_no, "limit": page_size}


async def parse_playlist_link(link: str) -> dict[str, Any]:
    """上游 ParsePlaylist：songlist/tracklist/playlist 链接、*id= 参数、或裸歌单 id。"""
    raw = str(link if link is not None else "").strip()
    patterns = (
        re.compile(r"music\.91q\.com/(?:songlist|tracklist|playlist)/([A-Za-z0-9]+)"),
        re.compile(r"(?:songlistid|tracklistid|playlistid|id)=([A-Za-z0-9]+)"),
    )
    for pattern in patterns:
        match = pattern.search(raw)
        if match:
            return await get_playlist_detail(match.group(1))
    if raw and "/" not in raw:
        return await get_playlist_detail(raw)
    raise RuntimeError("无效的千千歌单链接")
