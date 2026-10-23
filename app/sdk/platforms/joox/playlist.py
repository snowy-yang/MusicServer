"""JOOX 歌单（对应 sdk/joox/playlist.ts，上游 joox/playlist.go 移植）。

两条路：OpenJOOX 接口 + 网页数据兜底。
  搜索：GET https://cache.api.joox.com/openjoox/v3/search（``item.type=1`` → ``editor_playlist``）
  曲目：GET https://cache.api.joox.com/openjoox2/v1/playlist/<id>/tracks?...&secret=
        （上游 playlist.go 里的 openjoox/v3/playlist 已 404；网页兜底仍保留）
  兜底：www.joox.com/{id,sg,hk}/playlist/<id> SSR ``__NEXT_DATA__`` 的
        props.pageProps.allPlaylistTracks / playlistDetailList（含 content.page 嵌套变体）
  分类：www.joox.com/sg/playlist（302 → /<region> 首页）``__NEXT_DATA__.props.pageProps.mlList``
        ⚠ 分类与页面兜底都依赖 X-Forwarded-For 伪装的东南亚 IP。本机出口 IP 非东南亚时实测被拦截
        （页面只回「Sorry, JOOX is not available in this location」，无 __NEXT_DATA__），
        因此 get_categories / get_category_playlists 在当前网络环境下会如实抛错，不返回假数据。
  链接解析：joox.com/{region}/playlist/<id>、playlistid/id 查询参数、裸 ID。

路径里的歌单 id 与 TS 一致原样插入（含 ``+`` ``=``）；签名只覆盖 query 参数、不含路径。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.joox.music_info import JOOX_OPENJOOX2
from app.sdk.platforms.joox.music_search import SEARCH_URL
from app.sdk.platforms.joox.song import joox_song_from_track
from app.sdk.platforms.joox.util import (
    JOOX_TIMEOUT,
    decode_joox_base64_text,
    encode_uri_component,
    extract_joox_next_data,
    fetch_joox_page,
    first_non_empty,
    first_non_zero,
    joox_headers,
    joox_playlist_link,
    joox_playlist_links,
    joox_sign,
    normalize_joox_id,
    normalize_joox_lang,
    pick_joox_image,
)

CATEGORY_PAGE = "https://www.joox.com/sg/playlist"


def map_playlist_summary(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    playlist_id = normalize_joox_id(item.get("id"))
    if not playlist_id:
        return None
    return {
        "id": playlist_id,
        "name": str(item.get("name") or ""),
        "cover": pick_joox_image(item.get("images")) or None,
        "trackCount": 0,
        "creator": "",
        "description": "",
        "link": joox_playlist_link(playlist_id),
        "source": "joox",
    }


async def fetch_playlist_tracks(playlist_id: str, page: int, limit: int) -> dict[str, Any] | None:
    """openjoox2 歌单曲目（含歌单元信息）。"""
    country = "hk"
    lang = normalize_joox_lang("zh_hk")
    index = max(0, (page - 1) * limit)
    params: dict[str, Any] = {"country": country, "lang": lang, "index": index, "num": limit}
    url = (
        f"{JOOX_OPENJOOX2}/playlist/{playlist_id}/tracks?"
        f"country={country}&lang={lang}&index={index}&num={limit}&secret={joox_sign(params)}"
    )
    res = await http_fetch(url, headers=joox_headers(), timeout=JOOX_TIMEOUT)
    body = res.body
    if res.status_code != 200 or not isinstance(body, dict) or body.get("code"):
        return None

    tracks = body.get("tracks")
    items = tracks.get("items") if isinstance(tracks, dict) else None
    songs = [
        song
        for song in (
            joox_song_from_track(item, str(body.get("name") or ""), pick_joox_image(body.get("images")))
            for item in (items or [])
        )
        if song
    ]
    if not songs:
        return None

    total = first_non_zero(
        tracks.get("total_count") if isinstance(tracks, dict) else None,
        tracks.get("list_count") if isinstance(tracks, dict) else None,
        body.get("track_count"),
        len(songs),
    )
    return {
        "source": "joox",
        "info": {
            "name": str(first_non_empty(body.get("name"), playlist_id)),
            "img": pick_joox_image(body.get("images")) or None,
            "desc": str(first_non_empty(body.get("description"), body.get("publish_date"))),
            "author": "",
        },
        "list": songs,
        "page": page,
        "limit": limit,
        "total": total,
    }


def _track_items(tracks: Any) -> list[Any]:
    if not isinstance(tracks, dict):
        return []
    items = tracks.get("items")
    return items if isinstance(items, list) else []


def _track_total(*candidates: Any) -> Any:
    return first_non_zero(*candidates)


def _nested_name(detail: dict[str, Any], key: str) -> Any:
    """TS 里 ``detail?.user?.name`` 这类嵌套取值的兑底链（name → userName → nickName → nick）。"""
    node = detail.get(key)
    if not isinstance(node, dict):
        return None
    return first_non_empty(node.get("name"), node.get("userName"), node.get("nickName"), node.get("nick"))


def parse_playlist_page_data(next_data: Any, page_url: str) -> dict[str, Any] | None:
    """网页兜底：解析歌单 SSR 数据（上游 fetchPlaylistPageDataFromURL 的移植）。"""
    page_props = ((next_data or {}).get("props") or {}).get("pageProps") or {}
    detail: dict[str, Any] = page_props.get("playlistDetailList") or {}
    tracks = _track_items((page_props.get("allPlaylistTracks") or {}).get("tracks"))
    track_count = _track_total(
        ((page_props.get("allPlaylistTracks") or {}).get("tracks") or {}).get("total_count"),
        ((page_props.get("allPlaylistTracks") or {}).get("tracks") or {}).get("totalCount"),
        ((page_props.get("allPlaylistTracks") or {}).get("tracks") or {}).get("list_count"),
    )
    if not tracks:
        tracks = detail.get("trackList") or []
        track_count = _track_total(
            track_count,
            detail.get("trackCount"),
            detail.get("totalCount"),
            detail.get("total_count"),
            detail.get("list_count"),
        )
    if not tracks:
        nested = (page_props.get("content") or {}).get("page") or {}
        detail = nested.get("playlistDetailList") or {}
        tracks = _track_items((nested.get("allPlaylistTracks") or {}).get("tracks"))
        track_count = _track_total(
            ((nested.get("allPlaylistTracks") or {}).get("tracks") or {}).get("total_count"),
            ((nested.get("allPlaylistTracks") or {}).get("tracks") or {}).get("totalCount"),
            ((nested.get("allPlaylistTracks") or {}).get("tracks") or {}).get("list_count"),
            track_count,
        )
        if not tracks:
            tracks = detail.get("trackList") or []
            track_count = _track_total(
                track_count,
                detail.get("trackCount"),
                detail.get("totalCount"),
                detail.get("total_count"),
                detail.get("list_count"),
            )
    if not tracks:
        return None

    playlist_id = normalize_joox_id(first_non_empty(detail.get("id"), detail.get("listId"), detail.get("playlistId")))
    name = str(first_non_empty(detail.get("name"), detail.get("title"), detail.get("playlistName"), playlist_id))
    cover = str(first_non_empty(detail.get("imgSrc"), detail.get("cover"), detail.get("image"), detail.get("pic")))
    creator = first_non_empty(
        detail.get("creator"),
        detail.get("creatorName"),
        detail.get("userName"),
        detail.get("nickName"),
        detail.get("ownerName"),
        detail.get("author"),
        detail.get("authorName"),
        _nested_name(detail, "user"),
        _nested_name(detail, "owner"),
        _nested_name(detail, "creatorInfo"),
    )
    description = first_non_empty(detail.get("description"), detail.get("intro"), detail.get("desc"))
    return {
        "id": playlist_id,
        "name": name,
        "cover": cover,
        "creator": creator,
        "description": description,
        "trackCount": track_count,
        "tracks": tracks,
        "pageUrl": page_url,
    }


async def get_playlist_detail_from_page(raw_id: str) -> dict[str, Any]:
    """网页兜底：逐个区域尝试歌单页（上游 fetchPlaylistPageData / ParsePlaylist 的页面路径）。"""
    playlist_id = normalize_joox_id(raw_id)
    if not playlist_id:
        raise RuntimeError("joox 歌单 id 无效")
    last_err: Exception | None = None
    for page_url in joox_playlist_links(playlist_id):
        try:
            page = await fetch_joox_page(page_url)
            parsed = parse_playlist_page_data(extract_joox_next_data(page["body"]), page_url)
            if not parsed:
                raise RuntimeError("joox 歌单页数据不存在")
            page_id = normalize_joox_id(parsed["id"]) or playlist_id
            cover = str(parsed["cover"] or "")
            songs = [
                song
                for song in (joox_song_from_track(item, parsed["name"], cover) for item in parsed["tracks"])
                if song
            ]
            if not songs:
                raise RuntimeError("joox 歌单无歌曲")
            return {
                "source": "joox",
                "info": {
                    "name": str(parsed["name"] or page_id),
                    "img": cover or None,
                    "desc": str(parsed["description"] or ""),
                    "author": str(parsed["creator"] or ""),
                },
                "list": songs,
                "page": 1,
                "limit": len(songs),
                "total": first_non_zero(parsed["trackCount"], len(songs)),
            }
        except Exception as err:  # noqa: BLE001 - 逐个区域尝试，全部失败才抛最后一个错误
            last_err = err
    raise last_err or RuntimeError("joox 歌单页数据不存在")


async def get_playlist_detail(playlist_id: str, page: int = 1, limit: int = 50) -> dict[str, Any]:
    """歌单详情：openjoox2 通道优先，网页兜底（上游两条路都保留）。"""
    normalized = normalize_joox_id(playlist_id)
    if not normalized:
        raise RuntimeError("joox 歌单 id 无效")
    try:
        detail = await fetch_playlist_tracks(normalized, page, limit)
        if detail:
            return detail
    except Exception:  # noqa: BLE001 - 降级链：通道不可用时走网页兜底
        pass
    return await get_playlist_detail_from_page(normalized)


async def get_playlist_songs(playlist_id: str, page: int = 1, limit: int = 50) -> list[dict[str, Any]]:
    """歌单曲目（上游 GetPlaylistSongs：仅曲目列表；v3 接口 404 时用网页兜底）。"""
    normalized = normalize_joox_id(playlist_id)
    try:
        detail = await fetch_playlist_tracks(normalized, page, limit)
        if detail:
            return detail["list"]
    except Exception:  # noqa: BLE001 - 走网页兜底
        pass
    from_page = await get_playlist_detail_from_page(normalized)
    return from_page["list"]


async def search_playlist(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """歌单搜索（上游 SearchPlaylist）。"""
    url = f"{SEARCH_URL}?country=sg&lang=zh_cn&keyword={encode_uri_component(str(keyword or ''))}"
    res = await http_fetch(url, headers=joox_headers(), timeout=JOOX_TIMEOUT)
    body = res.body
    if res.status_code != 200 or not isinstance(body, dict) or not body.get("section_list"):
        return {"list": [], "total": 0, "page": page, "limit": limit, "source": "joox"}

    playlists: list[dict[str, Any]] = []
    seen: set[str] = set()
    for section in body["section_list"]:
        if not isinstance(section, dict):
            continue
        for item in section.get("item_list") or []:
            if not isinstance(item, dict) or _as_int(item.get("type")) != 1:
                continue
            summary = map_playlist_summary(item.get("editor_playlist"))
            if not summary or summary["id"] in seen:
                continue
            seen.add(summary["id"])
            playlists.append(summary)

    return {"list": playlists[:limit], "total": len(playlists), "page": page, "limit": limit, "source": "joox"}


async def fetch_playlist_categories_page() -> dict[str, Any]:
    """歌单分类页原始数据（上游 fetchJooxPlaylistCategoriesPage）。"""
    page = await fetch_joox_page(CATEGORY_PAGE)
    next_data = extract_joox_next_data(page["body"])
    ml_list = ((next_data or {}).get("props") or {}).get("pageProps", {})
    ml_list = (ml_list or {}).get("mlList")
    if not isinstance(ml_list, dict) or not ml_list.get("category"):
        raise RuntimeError("joox 歌单分类不存在")
    return ml_list


def category_playlist_id(value: Any) -> str:
    """分类 id：上游 jooxCategoryPlaylistID（数字/字符串都归一）。"""
    if value is None:
        return ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(int(value))
    return normalize_joox_id(value)


def _categories(ml_list: dict[str, Any]) -> list[Any]:
    categories = ml_list.get("category")
    return categories if isinstance(categories, list) else []


async def get_categories() -> dict[str, Any]:
    """分类列表（上游 GetPlaylistCategories；首个为「全部」）。"""
    data = await fetch_playlist_categories_page()
    items: list[dict[str, Any]] = [{"id": "", "name": "全部", "group": "全部", "hot": False}]
    for index, category in enumerate(_categories(data)):
        if not isinstance(category, dict):
            continue
        name = decode_joox_base64_text(category.get("title"))
        entries = category.get("itemlist")
        entries = entries if isinstance(entries, list) else []
        if not name or not entries:
            continue
        items.append({"id": str(index), "name": name, "group": "JOOX", "hot": False, "count": len(entries)})
    if len(items) == 1:
        raise RuntimeError("joox 歌单分类不存在")
    return {"source": "joox", "list": items}


async def get_category_playlists(category_id: str = "", page: int = 1, limit: int = 20) -> dict[str, Any]:
    """分类下歌单（上游 GetCategoryPlaylists）。"""
    data = await fetch_playlist_categories_page()
    cid = str(category_id or "").strip()
    items: list[Any] = []
    category_name = "全部"

    if not cid:
        seen: set[str] = set()
        for category in _categories(data):
            if not isinstance(category, dict):
                continue
            for item in category.get("itemlist") or []:
                entry_id = category_playlist_id(item.get("id") if isinstance(item, dict) else None)
                if not entry_id or entry_id in seen:
                    continue
                seen.add(entry_id)
                items.append(item)
    else:
        for index, category in enumerate(_categories(data)):
            if not isinstance(category, dict):
                continue
            name = decode_joox_base64_text(category.get("title"))
            if str(index) == cid or (name and name.lower() == cid.lower()):
                entries = category.get("itemlist")
                items = entries if isinstance(entries, list) else []
                category_name = name
                break
        if not items:
            raise RuntimeError("joox 歌单分类不存在")

    start = max(0, (page - 1) * limit)
    if start >= len(items):
        raise RuntimeError("joox 分类下无歌单")
    page_items = items[start : start + limit]

    playlists: list[dict[str, Any]] = []
    for item in page_items:
        if not isinstance(item, dict):
            continue
        entry_id = category_playlist_id(item.get("id"))
        name = decode_joox_base64_text(item.get("title"))
        if not entry_id or not name:
            continue
        playlists.append(
            {
                "id": entry_id,
                "name": name,
                "cover": str(item.get("picurl") or "").replace("%d", "300") or None,
                "trackCount": 0,
                "creator": "",
                "description": "",
                "link": joox_playlist_link(entry_id),
                "categoryId": cid,
                "categoryName": category_name,
                "source": "joox",
            }
        )
    if not playlists:
        raise RuntimeError("joox 分类下无歌单")

    return {"list": playlists, "total": len(items), "page": page, "limit": limit, "source": "joox"}


async def parse_playlist(link: str) -> dict[str, Any]:
    """歌单链接解析（上游 ParsePlaylist）。"""
    raw = str(link or "")
    for pattern in (
        r"joox\.com/.*/playlist/([^/?#]+)",
        r"(?:playlistid|playlist_id|id)=([^&]+)",
    ):
        match = re.search(pattern, raw)
        if match:
            return await get_playlist_detail(match.group(1))
    stripped = raw.strip()
    if len(stripped) > 8 and "/" not in stripped:
        return await get_playlist_detail(stripped)
    raise RuntimeError("invalid joox playlist link")


def _as_int(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None
