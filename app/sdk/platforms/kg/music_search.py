"""酷狗搜索（对应 sdk/kg/musicSearch.ts）。"""

from __future__ import annotations

import math
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import decode_name, format_play_time, format_singer_name, size_formate
from app.sdk.platforms.kg.util import encode_uri_component

DEFAULT_LIMIT = 30

_SEARCH_API = "https://songsearch.kugou.com/song_search_v2"


def _filter_data(raw: dict[str, Any]) -> dict[str, Any]:
    types: list[dict[str, Any]] = []
    _types: dict[str, dict[str, Any]] = {}
    for quality, size_key, hash_key in (
        ("128k", "FileSize", "FileHash"),
        ("320k", "HQFileSize", "HQFileHash"),
        ("flac", "SQFileSize", "SQFileHash"),
        ("flac24bit", "ResFileSize", "ResFileHash"),
    ):
        if raw.get(size_key, 0) == 0:
            continue
        size = size_formate(raw.get(size_key))
        types.append({"type": quality, "size": size, "hash": raw.get(hash_key)})
        _types[quality] = {"size": size, "hash": raw.get(hash_key)}
    return {
        "singer": decode_name(format_singer_name(raw.get("Singers"), "name")),
        "name": decode_name(raw.get("SongName")),
        "albumName": decode_name(raw.get("AlbumName")),
        "albumId": raw.get("AlbumID"),
        "songmid": raw.get("Audioid"),
        "source": "kg",
        "interval": format_play_time(raw.get("Duration")),
        "_interval": raw.get("Duration"),
        "img": None,
        "lrc": None,
        "otherSource": None,
        "hash": raw.get("FileHash"),
        "types": types,
        "_types": _types,
        "typeUrl": {},
    }


def _handle_result(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """同名同 hash 去重；`Grp` 是同一首歌的其它版本，也一并展开。"""
    ids: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in raw_list:
        key = f"{item.get('Audioid')}{item.get('FileHash')}"
        if key in ids:
            continue
        ids.add(key)
        result.append(_filter_data(item))
        for child in item.get("Grp") or []:
            child_key = f"{child.get('Audioid')}{child.get('FileHash')}"
            if child_key in ids:
                continue
            ids.add(child_key)
            result.append(_filter_data(child))
    return result


async def search(keyword: str, page: int = 1, limit: int = DEFAULT_LIMIT, retry_num: int = 0) -> dict[str, Any]:
    if retry_num > 3:
        raise RuntimeError("try max num")
    page_size = DEFAULT_LIMIT if limit is None else limit
    url = (
        f"{_SEARCH_API}?keyword={encode_uri_component(keyword)}&page={page}&pagesize={page_size}"
        "&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1"
    )
    try:
        resp = await http_fetch(url)
    except Exception:  # noqa: BLE001 - 可降级失败：原实现同样重试同类请求
        return await search(keyword, page, limit, retry_num + 1)
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("error_code") != 0:
        return await search(keyword, page, limit, retry_num + 1)
    data = body.get("data") or {}
    raw_list = data.get("lists")
    if raw_list is None:
        return await search(keyword, page, limit, retry_num + 1)

    songs = _handle_result(raw_list)
    total = data.get("total") or 0
    return {
        "list": songs,
        "allPage": math.ceil(total / page_size) if page_size else 1,
        "limit": page_size,
        "total": total,
        "source": "kg",
    }
