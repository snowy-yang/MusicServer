"""酷狗歌手（对应 sdk/kg/singer.ts）。"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.kg.music_info import get_music_infos_by_list
from app.sdk.platforms.kg.util import create_http_fetch

SINGER_INFO_URL = "http://mobiles.kugou.com/api/v5/singer/info"
SINGER_ALBUM_URL = "http://mobiles.kugou.com/api/v5/singer/album"
SINGER_SONG_URL = "http://mobiles.kugou.com/api/v5/singer/song"


def _check_id(id: Any) -> None:
    # kg 源有些歌曲在歌手未被酷狗收录时返回的歌手 id 为 0
    if str(id) in ("0", ""):
        raise RuntimeError("歌手不存在")


async def get_info(id: str) -> dict[str, Any]:
    _check_id(id)
    body = await create_http_fetch(f"{SINGER_INFO_URL}?singerid={id}")
    body = body or {}
    if not body:
        raise RuntimeError("get singer info faild.")
    imgurl = str(body.get("imgurl") or "")
    return {
        "source": "kg",
        "id": body.get("singerid"),
        "info": {
            "name": body.get("singername"),
            "desc": body.get("intro"),
            "avatar": imgurl.replace("{size}", "480") if imgurl else "",
            "gender": "man" if body.get("grade") == 1 else "woman",
        },
        "count": {"music": body.get("songcount"), "album": body.get("albumcount")},
    }


def _filter_album_list(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "id": item.get("albumid"),
            "count": item.get("songcount"),
            "info": {
                "name": item.get("albumname"),
                "author": item.get("singername"),
                "img": str(item.get("imgurl") or item.get("img") or "").replace("{size}", "480"),
                "desc": item.get("intro"),
            },
        }
        for item in raw
    ]


async def get_album_list(id: str, page: int = 1, limit: int = 10) -> dict[str, Any]:
    _check_id(id)
    body = await create_http_fetch(f"{SINGER_ALBUM_URL}?singerid={id}&page={page}&pagesize={limit}")
    body = body or {}
    if not body.get("info"):
        raise RuntimeError("get singer album list faild.")
    return {
        "source": "kg",
        "list": _filter_album_list(body.get("info") or []),
        "limit": limit,
        "page": page,
        "total": body.get("total"),
    }


async def get_song_list(id: str, page: int = 1, limit: int = 100) -> dict[str, Any]:
    _check_id(id)
    body = await create_http_fetch(f"{SINGER_SONG_URL}?singerid={id}&page={page}&pagesize={limit}")
    body = body or {}
    if not body.get("info"):
        raise RuntimeError("get singer song list faild.")
    songs = await get_music_infos_by_list(body.get("info") or [])
    return {
        "source": "kg",
        "list": songs,
        "limit": limit,
        "page": page,
        "total": body.get("total"),
    }
