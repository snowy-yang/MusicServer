"""网易云专辑（移植自 sdk/wy/album.ts，上游 music-lib/netease/album.go + fetchAlbumDetail）。

搜索：cloudsearch pc type=10（eapi 通道）
详情/曲目：weapi/v1/album/<id>（匿名可用，登录 cookie 可选）
链接解析：#/album?id= / /album?id= / /album/<id>（上游 parseNeteaseLink）
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import format_play_time, format_singer_name, size_formate
from app.sdk.platforms.wy.link import parse_netease_link
from app.sdk.platforms.wy.utils import eapi_request, weapi_headers
from app.sdk.platforms.wy.utils.crypto import weapi

ALBUM_LINK = "https://music.163.com/#/album?id={}"


def album_link(album_id: str) -> str:
    return ALBUM_LINK.format(album_id)


def convert_song(item: dict[str, Any]) -> dict[str, Any]:
    """网易云歌曲条目 → SongInfo（与 song_list.filter_list_detail 对齐）。

    这里只在尺寸为正数时声明档位（专辑接口不带 privilege，只能按资源块推断）。
    """
    types: list[dict[str, Any]] = []
    _types: dict[str, dict[str, Any]] = {}

    def push(kind: str, size_raw: Any) -> None:
        size = size_formate(size_raw) if isinstance(size_raw, (int, float)) and size_raw > 0 else None
        if not size:
            return
        types.append({"type": kind, "size": size})
        _types[kind] = {"size": size}

    push("128k", (item.get("l") or {}).get("size") if isinstance(item.get("l"), dict) else None)
    push("320k", (item.get("h") or {}).get("size") if isinstance(item.get("h"), dict) else None)
    push("flac", (item.get("sq") or {}).get("size") if isinstance(item.get("sq"), dict) else None)
    push("flac24bit", (item.get("hr") or {}).get("size") if isinstance(item.get("hr"), dict) else None)

    album = item.get("al") if isinstance(item.get("al"), dict) else {}
    if not album:
        album = item.get("album") if isinstance(item.get("album"), dict) else {}
    album = album if isinstance(album, dict) else {}
    return {
        "singer": format_singer_name(item.get("ar"), "name"),
        "name": item.get("name") or "",
        "albumName": album.get("name") or "",
        "albumId": album.get("id"),
        "source": "wy",
        "interval": format_play_time((item.get("dt") or 0) / 1000),
        "songmid": item.get("id"),
        "img": album.get("picUrl") or "",
        "lrc": None,
        "otherSource": None,
        "types": types,
        "_types": _types,
        "typeUrl": {},
    }


async def fetch_album_detail(album_id: str) -> dict[str, Any]:
    """专辑详情 + 全量曲目。失败文案与原文一致（含上游 code）。"""
    album_key = str(album_id or "").strip()
    if not album_key:
        raise RuntimeError("wy 专辑 id 为空")

    resp = await http_fetch(
        f"https://music.163.com/weapi/v1/album/{album_key}",
        method="post",
        headers=weapi_headers(),
        form=weapi({"csrf_token": ""}),
        timeout=15000,
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 200:
        raise RuntimeError(f"wy 专辑详情获取失败 (code {body.get('code', resp.status_code)})")

    album = body.get("album") or {}
    artist = album.get("artist") or {}
    artist_name = artist.get("name") or "、".join(
        str(a.get("name")) for a in album.get("artists") or [] if isinstance(a, dict) and a.get("name")
    )
    songs = [convert_song(song) for song in body.get("songs") or [] if isinstance(song, dict)]
    return {
        "source": "wy",
        "info": {
            "name": album.get("name") or "",
            "img": album.get("picUrl") or "",
            "desc": album.get("description") or album.get("briefDesc") or "",
            "author": artist_name or "",
            "albumId": str(album.get("id") or album_key),
            "publishTime": album.get("publishTime"),
            "company": album.get("company") or "",
        },
        "list": songs,
        "total": int(album.get("size") or 0) or len(songs),
    }


async def get_album_detail(album_id: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """专辑详情（本地按 page/limit 切片）。"""
    detail = await fetch_album_detail(album_id)
    start = max(0, (page - 1) * limit)
    return {
        "source": "wy",
        "info": detail["info"],
        "list": detail["list"][start : start + limit],
        "page": page,
        "limit": limit,
        "total": detail["total"] or len(detail["list"]),
    }


async def get_album_songs(album_id: str) -> list[dict[str, Any]]:
    return (await fetch_album_detail(album_id))["list"]


async def search_album(keyword: str, page: int = 1, limit: int = 10) -> dict[str, Any]:
    """专辑搜索（eapi cloudsearch pc type=10）。"""
    resp = await eapi_request(
        "/api/cloudsearch/pc",
        {"s": str(keyword or ""), "type": 10, "limit": limit, "total": page == 1, "offset": limit * (page - 1)},
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 200:
        raise RuntimeError(f"wy 专辑搜索失败 (code {body.get('code', resp.status_code)})")

    result = body.get("result") or {}
    rows: list[dict[str, Any]] = []
    for item in result.get("albums") or []:
        if not isinstance(item, dict):
            continue
        id_ = str(item.get("id") or "").strip()
        if not id_:
            continue
        artist = item.get("artist") or {}
        artist_name = artist.get("name") or "、".join(
            str(a.get("name")) for a in item.get("artists") or [] if isinstance(a, dict) and a.get("name")
        )
        rows.append(
            {
                "id": id_,
                "name": item.get("name") or "",
                "cover": item.get("picUrl") or "",
                "trackCount": int(item.get("size") or 0),
                "creator": artist_name,
                "description": item.get("description") or item.get("briefDesc") or "",
                "link": album_link(id_),
                "type": "album",
                "company": item.get("company") or "",
                "publishTime": item.get("publishTime"),
                "source": "wy",
            }
        )
    total = int(result.get("albumCount") or 0) or len(rows)
    return {"list": rows, "page": page, "limit": limit, "total": total, "source": "wy"}


async def parse_album_link(link: str) -> dict[str, Any]:
    """专辑链接解析（裸数字 id 兜底，上游 ParseAlbum 只接受链接）。"""
    raw = str(link or "").strip()
    if raw.isdigit():
        return await get_album_detail(raw)
    kind, id_ = parse_netease_link(raw)
    if kind != "album":
        raise RuntimeError("无效的网易云专辑链接")
    return await get_album_detail(id_)
