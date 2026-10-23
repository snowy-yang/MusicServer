"""按 hash 批量反查歌曲信息（对应 sdk/kg/musicInfo.ts）。

多个模块（榜单/歌单/专辑/歌手/解析/路由兜底）都要把 hash 换成完整 SongInfo，
统一走这里：`http://gateway.kugou.com/v3/album_audio/audio`，每批最多 100 个 hash。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from app.sdk.common.utils import decode_name, format_play_time, size_formate
from app.sdk.platforms.kg.util import create_http_fetch

MUSIC_INFO_URL = "http://gateway.kugou.com/v3/album_audio/audio"

MUSIC_INFO_HEADERS = {
    "KG-THash": "13a3164",
    "KG-RC": "1",
    "KG-Fake": "0",
    "KG-RF": "00869891",
    "User-Agent": "Android712-AndroidPhone-11451-376-0-FeeCacheUpdate-wifi",
    "x-router": "kmr.service.kugou.com",
}

_FIELDS = "album_info,author_name,audio_info,ori_audio_name,base,songname,classification"


def _filter_music_info_list(raw_list: list[Any]) -> list[dict[str, Any]]:
    ids: set[Any] = set()
    result: list[dict[str, Any]] = []
    for item in raw_list:
        if not item:
            continue
        audio = item.get("audio_info") or {}
        if audio.get("audio_id") in ids:
            continue
        ids.add(audio.get("audio_id"))
        types: list[dict[str, Any]] = []
        _types: dict[str, dict[str, Any]] = {}
        for quality, size_key, hash_key in (
            ("128k", "filesize", "hash"),
            ("320k", "filesize_320", "hash_320"),
            ("flac", "filesize_flac", "hash_flac"),
            ("flac24bit", "filesize_high", "hash_high"),
        ):
            if str(audio.get(size_key, "0")) == "0":
                continue
            size = size_formate(int(audio.get(size_key) or 0))
            types.append({"type": quality, "size": size, "hash": audio.get(hash_key)})
            _types[quality] = {"size": size, "hash": audio.get(hash_key)}
        album = item.get("album_info") or {}
        result.append(
            {
                "singer": decode_name(item.get("author_name")),
                "name": decode_name(item.get("songname")),
                "albumName": decode_name(album.get("album_name")),
                "albumId": album.get("album_id"),
                "songmid": audio.get("audio_id"),
                "source": "kg",
                "interval": format_play_time(int(audio.get("timelength") or 0) / 1000),
                "img": None,
                "lrc": None,
                "hash": audio.get("hash"),
                "otherSource": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return result


def _build_tasks(hashs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    base = {
        "area_code": "1",
        "show_privilege": 1,
        "show_album_info": "1",
        "is_publish": "",
        "appid": 1005,
        "clientver": 11451,
        "mid": "1",
        "dfid": "-",
        "clienttime": int(time.time() * 1000),
        "key": "OIlwieks28dk2k092lksi2UIkp",
        "fields": _FIELDS,
    }
    tasks: list[dict[str, Any]] = []
    rest = list(hashs)
    while rest:
        tasks.append({"data": rest[:100], **base})
        if len(rest) < 100:
            break
        rest = rest[100:]
    return tasks


async def get_music_infos(hashs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按 hash 列表批量取 SongInfo（上游按 100 个一批并发，扁平化后去重）。"""

    async def one(task: dict[str, Any]) -> list[Any]:
        data = await create_http_fetch(MUSIC_INFO_URL, {"method": "POST", "body": task, "headers": MUSIC_INFO_HEADERS})
        items = data if isinstance(data, list) else []
        return [entry[0] if entry else None for entry in items]

    chunks = await asyncio.gather(*(one(task) for task in _build_tasks(hashs)))
    return _filter_music_info_list([item for chunk in chunks for item in chunk])


async def get_music_info_raw(hash: str) -> Any:
    tasks = _build_tasks([{"hash": hash}])
    if not tasks:
        return None
    data = await create_http_fetch(MUSIC_INFO_URL, {"method": "POST", "body": tasks[0], "headers": MUSIC_INFO_HEADERS})
    items = data if isinstance(data, list) else []
    flat = [entry[0] if entry else None for entry in items]
    return flat[0] if flat else None


async def get_music_info(hash: str) -> dict[str, Any] | None:
    infos = await get_music_infos([{"hash": hash}])
    return infos[0] if infos else None


async def get_music_infos_by_list(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """上游返回的 {hash} 列表 → 完整 SongInfo 列表。"""
    if not items:
        return []
    return await get_music_infos([{"hash": item.get("hash")} for item in items])


async def get_music_info_for_song_info(song_info: dict[str, Any]) -> dict[str, Any] | None:
    """顶层 `get_music_info(song_info)` 的实现：hash 优先，退回 songmid。"""
    hash_value = str(song_info.get("hash") or song_info.get("songmid") or "").strip()
    if not hash_value:
        return None
    return await get_music_info(hash_value)
