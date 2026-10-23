"""网易云歌手（移植自 sdk/wy/singer.ts）。

三个 eapi 接口：
  * /api/artist/head/info/get → 歌手信息
  * /api/v2/artist/songs      → 歌曲列表（音质档位来自 privilege.chargeInfoList）
  * /api/artist/albums/<id>   → 专辑列表
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.utils import format_play_time, format_singer_name, size_formate
from app.sdk.platforms.wy.utils import eapi_request


async def get_info(singer_id: str) -> dict[str, Any]:
    """歌手信息。失败文案与原文一致：get singer info faild.。"""
    resp = await eapi_request("/api/artist/head/info/get", {"id": singer_id})
    body = resp.body if isinstance(resp.body, dict) else {}
    if not body or body.get("code") != 200:
        raise RuntimeError("get singer info faild.")
    artist = (body.get("data") or {}).get("artist")
    if not isinstance(artist, dict):
        raise RuntimeError("get singer info faild.")
    return {
        "source": "wy",
        "id": artist.get("id"),
        "info": {
            "name": artist.get("name"),
            "desc": artist.get("briefDesc"),
            "avatar": artist.get("avatar") or artist.get("cover") or None,
            "gender": None,
        },
        "count": {
            "music": artist.get("musicSize"),
            "album": artist.get("albumSize"),
        },
    }


def _size_of(block: Any) -> str | None:
    if isinstance(block, dict) and block.get("size"):
        return size_formate(block["size"])
    return None


def filter_song_list(raw: Any) -> list[dict[str, Any]]:
    """歌手歌曲 → SongInfo。档位来自 privilege.chargeInfoList 的 rate（无直落，逐条 break）。"""
    rows: list[dict[str, Any]] = []
    for item in raw or []:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        types: list[dict[str, Any]] = []
        _types: dict[str, dict[str, Any]] = {}
        privilege = item.get("privilege") or {}
        for info in privilege.get("chargeInfoList") or []:
            if not isinstance(info, dict):
                continue
            rate = info.get("rate")
            if rate == 128000:
                size = _size_of(item.get("lMusic"))
                types.append({"type": "128k", "size": size})
                _types["128k"] = {"size": size}
            elif rate == 320000:
                size = _size_of(item.get("hMusic"))
                types.append({"type": "320k", "size": size})
                _types["320k"] = {"size": size}
            elif rate == 999000:
                size = _size_of(item.get("sqMusic"))
                types.append({"type": "flac", "size": size})
                _types["flac"] = {"size": size}
            elif rate == 1999000:
                size = _size_of(item.get("hrMusic"))
                types.append({"type": "flac24bit", "size": size})
                _types["flac24bit"] = {"size": size}

        raw_album = item.get("album")
        album: dict[str, Any] = raw_album if isinstance(raw_album, dict) else {}
        rows.append(
            {
                "singer": format_singer_name(item.get("artists")),
                "name": item.get("name"),
                "albumName": album.get("name"),
                "albumId": album.get("id"),
                "songmid": item.get("id"),
                "source": "wy",
                "interval": format_play_time((item.get("dt") or item.get("duration") or 0) / 1000),
                "img": album.get("picUrl"),
                "lrc": None,
                "otherSource": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return rows


async def get_song_list(singer_id: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """歌手歌曲列表。失败文案：get singer song list faild.。"""
    resp = await eapi_request("/api/v2/artist/songs", {"id": singer_id, "limit": limit, "offset": (page - 1) * limit})
    body = resp.body if isinstance(resp.body, dict) else {}
    if not body.get("songs") or body.get("code") != 200:
        raise RuntimeError("get singer song list faild.")
    return {
        "list": filter_song_list(body.get("songs")),
        "limit": limit,
        "page": page,
        "total": body.get("total"),
        "source": "wy",
    }


def filter_album_list(raw: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in raw or []:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        rows.append(
            {
                "id": item.get("id"),
                "count": item.get("size"),
                "info": {
                    "name": item.get("name"),
                    "author": format_singer_name(item.get("artists")),
                    "img": item.get("picUrl"),
                    "desc": None,
                },
            }
        )
    return rows


async def get_album_list(singer_id: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """歌手专辑列表。失败文案：get singer album list faild.。"""
    resp = await eapi_request(f"/api/artist/albums/{singer_id}", {"limit": limit, "offset": (page - 1) * limit})
    body = resp.body if isinstance(resp.body, dict) else {}
    if not body.get("hotAlbums") or body.get("code") != 200:
        raise RuntimeError("get singer album list faild.")
    artist = body.get("artist") or {}
    return {
        "source": "wy",
        "list": filter_album_list(body.get("hotAlbums")),
        "limit": limit,
        "page": page,
        "total": artist.get("albumSize"),
    }
