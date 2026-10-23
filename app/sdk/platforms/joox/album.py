"""JOOX 专辑（对应 sdk/joox/album.ts，上游 joox/album.go 移植 + 新版 openjoox2 通道）。

搜索：GET https://cache.api.joox.com/openjoox/v3/search（``section_type=1`` 专辑区，``item.type=2``）
曲目：GET https://cache.api.joox.com/openjoox2/v1/album/<id>/tracks?country=hk&lang=zh_TW&index=&num=&secret=
      （web 播放器通道，需 md5 签名；实测 2026-10 HTTP 200）
兜底：www.joox.com/<region>/album/<id> SSR ``__NEXT_DATA__.props.pageProps.albumData``
      ⚠ 该兜底依赖 X-Forwarded-For 伪装的东南亚 IP；本机出口 IP 非东南亚时实测被拦截
      （页面只回「Sorry, JOOX is not available in this location」，无 __NEXT_DATA__），
      因此该路径在当前网络环境下不可用，仅在 openjoox2 失败时尝试，失败即如实抛出。
链接解析：ParseAlbum 的正则与裸 ID 规则同上游。

路径里的 album id 与 TS 一致原样插入（含 ``+`` ``=``）；签名只覆盖 query 参数、不含路径，
故路径写法不影响 secret 校验。
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
    encode_uri_component,
    extract_joox_next_data,
    fetch_joox_page,
    first_non_empty,
    first_non_zero,
    joox_album_link,
    joox_artists,
    joox_headers,
    joox_sign,
    normalize_joox_id,
    normalize_joox_lang,
    pick_joox_image,
    to_int,
)


async def fetch_album_tracks(album_id: str, page: int, limit: int) -> dict[str, Any] | None:
    """openjoox2 专辑曲目（含专辑元信息）。"""
    country = "hk"
    lang = normalize_joox_lang("zh_hk")
    index = max(0, (page - 1) * limit)
    params: dict[str, Any] = {"country": country, "lang": lang, "index": index, "num": limit}
    url = (
        f"{JOOX_OPENJOOX2}/album/{album_id}/tracks?"
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
            joox_song_from_track(item, str(body.get("name") or ""), pick_joox_image(body.get("images")), album_id)
            for item in (items or [])
        )
        if song
    ]
    if not songs:
        return None

    total = first_non_zero(
        tracks.get("total_count") if isinstance(tracks, dict) else None,
        tracks.get("list_count") if isinstance(tracks, dict) else None,
        len(songs),
    )
    return {
        "source": "joox",
        "info": {
            "name": str(first_non_empty(body.get("name"), album_id)),
            "img": pick_joox_image(body.get("images")) or None,
            "desc": str(first_non_empty(body.get("description"), body.get("publish_date"))),
            "author": joox_artists(body.get("artist_list")),
        },
        "list": songs,
        "page": page,
        "limit": limit,
        "total": total,
    }


async def fetch_album_page_data(album_id: str) -> dict[str, Any]:
    """SSR 页面专辑数据（上游 fetchAlbumPageData + fetchAlbumDetail 的 data 部分）。"""
    page = await fetch_joox_page(joox_album_link(album_id))
    next_data = extract_joox_next_data(page["body"])
    page_props = ((next_data or {}).get("props") or {}).get("pageProps") or {}
    album_data = page_props.get("albumData")
    if isinstance(album_data, dict) and normalize_joox_id(album_data.get("id")):
        return album_data
    nested = ((page_props.get("content") or {}).get("page") or {}).get("albumData")
    if isinstance(nested, dict) and normalize_joox_id(nested.get("id")):
        return nested
    raise RuntimeError("joox 专辑页数据不存在")


async def get_album_detail_from_page(album_id: str, page: int = 1, limit: int = 50) -> dict[str, Any]:
    """专辑详情（SSR 网页兜底通道，上游 fetchAlbumDetail 的页面路径）。"""
    album_id = normalize_joox_id(album_id)
    if not album_id:
        raise RuntimeError("joox 专辑 id 无效")
    album_data = await fetch_album_page_data(album_id)
    track_list = album_data.get("trackList")
    items = track_list.get("items") if isinstance(track_list, dict) else None
    items = items if isinstance(items, list) else []
    page_start = max(0, (page - 1) * limit)
    page_items = items[page_start : page_start + limit]
    cover = str(first_non_empty(pick_joox_image(album_data.get("images")), album_data.get("imgSrc")))
    songs = [
        song
        for song in (
            joox_song_from_track(item, str(album_data.get("title") or ""), cover, album_id) for item in page_items
        )
        if song
    ]
    if not songs:
        raise RuntimeError("joox 专辑无歌曲")

    total = first_non_zero(
        track_list.get("total_count") if isinstance(track_list, dict) else None,
        track_list.get("list_count") if isinstance(track_list, dict) else None,
        len(items),
    )
    return {
        "source": "joox",
        "info": {
            "name": str(first_non_empty(album_data.get("title"), album_id)),
            "img": cover or None,
            "desc": str(first_non_empty(album_data.get("description"), album_data.get("publishDate"))),
            "author": joox_artists(album_data.get("artistList")),
        },
        "list": songs,
        "page": page,
        "limit": limit,
        "total": total,
    }


async def get_album_detail(album_id: str, page: int = 1, limit: int = 50) -> dict[str, Any]:
    """专辑详情（openjoox2 优先，SSR 页兜底）。"""
    normalized = normalize_joox_id(album_id)
    if not normalized:
        raise RuntimeError("joox 专辑 id 无效")
    try:
        detail = await fetch_album_tracks(normalized, page, limit)
        if detail:
            return detail
    except Exception:  # noqa: BLE001 - 降级链：通道不可用时走页面兜底
        pass
    return await get_album_detail_from_page(normalized, page, limit)


async def get_album_songs(album_id: str, page: int = 1, limit: int = 50) -> list[dict[str, Any]]:
    """专辑曲目（上游 GetAlbumSongs：仅曲目列表）。"""
    detail = await get_album_detail(album_id, page, limit)
    return detail["list"]


async def search_album(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """专辑搜索（上游 SearchAlbum）。"""
    url = f"{SEARCH_URL}?country=sg&lang=zh_cn&keyword={encode_uri_component(str(keyword or ''))}"
    res = await http_fetch(url, headers=joox_headers(), timeout=JOOX_TIMEOUT)
    body = res.body
    if res.status_code != 200 or not isinstance(body, dict) or not body.get("section_list"):
        return {"list": [], "total": 0, "page": page, "limit": limit, "source": "joox"}

    albums: list[dict[str, Any]] = []
    seen: set[str] = set()
    for section in body["section_list"]:
        if not isinstance(section, dict) or to_int(section.get("section_type")) != 1:
            continue
        for item in section.get("item_list") or []:
            if not isinstance(item, dict) or to_int(item.get("type")) != 2:
                continue
            raw_album = item.get("album")
            album = raw_album if isinstance(raw_album, dict) else {}
            album_id = normalize_joox_id(album.get("id"))
            if not album_id or album_id in seen:
                continue
            seen.add(album_id)
            publish_date = str(album.get("publish_date") or "").strip()
            albums.append(
                {
                    "id": album_id,
                    "name": str(album.get("name") or ""),
                    "cover": pick_joox_image(album.get("images")) or None,
                    "creator": joox_artists(album.get("artist_list")),
                    "description": publish_date,
                    "publishDate": publish_date,
                    "trackCount": 0,
                    "link": joox_album_link(album_id),
                    "source": "joox",
                }
            )

    return {"list": albums[:limit], "total": len(albums), "page": page, "limit": limit, "source": "joox"}


async def parse_album(link: str) -> dict[str, Any]:
    """专辑链接解析（上游 ParseAlbum）。"""
    raw = str(link or "")
    for pattern in (
        r"joox\.com/.*/album/([^/?#]+)",
        r"h_activity_id=([^&]+)",
        r"albumid=([^&]+)",
    ):
        match = re.search(pattern, raw)
        if match:
            return await get_album_detail(match.group(1))
    stripped = raw.strip()
    if len(stripped) > 10 and "/" not in stripped:
        return await get_album_detail(stripped)
    raise RuntimeError("invalid joox album link")
