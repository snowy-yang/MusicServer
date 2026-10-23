"""咪咕专辑（对应 sdk/mg/album.ts）。

搜索（search_all.do 的 album 开关）+ 曲目（queryAlbumSong，分页聚合去重）+
详情（resourceinfo 2003 的元数据）。上游对应 music-lib/migu/album.go、
migu.go 的 fetchAlbumDetail / fetchAlbumSongs。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.platforms.mg.music_search import search_all
from app.sdk.platforms.mg.util import (
    build_url,
    convert_item_to_song,
    first_non_empty,
    migu_album_link,
    migu_get,
    pick_migu_image,
    to_number,
)

QUERY_ALBUM_SONG_URL = "https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/queryAlbumSong"
RESOURCE_INFO_URL = "https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do"

_ALBUM_PATTERNS = (
    re.compile(r"music\.migu\.cn/(?:v3|v5)/music/album/(\d+)"),
    re.compile(r"albumId=(\d+)"),
    re.compile(r"resourceId=(\d+)"),
)


async def search_album(keyword: str, page: int = 1, limit: int = 10) -> dict[str, Any]:
    body = await search_all(keyword, "album", page, limit)
    data = body.get("albumResultData") if isinstance(body, dict) else None
    result = (data or {}).get("result") or []
    album_list: list[dict[str, Any]] = []
    for item in result:
        album_id = str(item.get("id") or "").strip()
        if not album_id:
            continue
        album_list.append(
            {
                "id": album_id,
                "name": str(item.get("name") or "").strip(),
                "cover": pick_migu_image(item.get("imgItems")),
                "creator": str(item.get("singer") or "").strip(),
                "description": first_non_empty(item.get("desc"), item.get("publishDate")),
                "link": migu_album_link(album_id),
                "source": "mg",
            }
        )
    return {"list": album_list, "source": "mg", "page": page, "limit": limit, "total": len(album_list)}


async def fetch_album_songs(album_id: str) -> dict[str, Any]:
    """专辑曲目（每页 50 全量翻页 + 去重；上游 fetchAlbumSongs）。"""
    album = str(album_id or "").strip()
    if not album:
        raise RuntimeError("migu 专辑 id 为空")
    page_size = 50
    seen: set[str] = set()
    songs: list[dict[str, Any]] = []
    total_count = 0

    page_no = 1
    while True:
        body = await migu_get(
            build_url(QUERY_ALBUM_SONG_URL, {"albumId": album, "pageNo": page_no, "pageSize": page_size})
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
        raise RuntimeError("migu 专辑没有可播放歌曲")
    return {"songs": songs, "total": total_count or len(songs)}


async def get_album_detail(album_id: str, page: int = 1, limit: int = 50) -> dict[str, Any]:
    """专辑详情（曲目 + resourceinfo 2003 的元数据），返回形状对齐 kg/kw 的专辑详情。"""
    album = str(album_id or "").strip()
    if not album:
        raise RuntimeError("migu 专辑 id 为空")
    fetched = await fetch_album_songs(album)
    songs: list[dict[str, Any]] = fetched["songs"]
    total: int = fetched["total"]

    info: dict[str, str] = {"name": album, "img": "", "desc": "", "author": ""}
    try:
        body = await migu_get(
            build_url(RESOURCE_INFO_URL, {"needSimple": "00", "resourceType": "2003", "resourceId": album})
        )
        body = body if isinstance(body, dict) else {}
        if body.get("code") and body["code"] != "000000":
            raise RuntimeError(str(body.get("info")))
        resource = body.get("resource") or []
        res = resource[0] if resource and isinstance(resource[0], dict) else None
        if res:
            info = {
                "name": str(res.get("title") or "").strip() or album,
                "img": pick_migu_image(res.get("imgItems")),
                "desc": str(res.get("summary") or "").strip(),
                "author": str(res.get("singer") or "").strip(),
            }
            if not info["img"] and songs[0].get("img"):
                info["img"] = str(songs[0]["img"])
    except Exception:  # noqa: BLE001 - 元数据是锦上添花，失败仍返回曲目
        if songs[0].get("img"):
            info["img"] = str(songs[0]["img"])

    start = (page - 1) * limit
    return {
        "source": "mg",
        "info": info,
        "list": songs[start : start + limit],
        "page": page,
        "limit": limit,
        "total": total or len(songs),
    }


async def get_album_songs(album_id: str) -> list[dict[str, Any]]:
    return (await fetch_album_songs(album_id))["songs"]


async def parse_album_link(link: str) -> dict[str, Any]:
    raw = str(link or "")
    for pattern in _ALBUM_PATTERNS:
        match = pattern.search(raw)
        if match:
            return await get_album_detail(match.group(1))
    raise RuntimeError("无效的咪咕专辑链接")
