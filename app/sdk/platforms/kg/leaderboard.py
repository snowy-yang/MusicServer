"""酷狗榜单（对应 sdk/kg/leaderboard.ts）。

榜单 id 表是硬编码的静态表（原实现 getBoards 直接返回它，不请求上游）；
详情走 `mobilecdnbj.kugou.com/api/v3/rank/song`，返回的 hash 需再反查一次 SongInfo
才能拿到多档音质。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import decode_name, format_play_time, size_formate

LIST_DETAIL_LIMIT = 100

BOARD_LIST: list[dict[str, str]] = [
    {"id": "kgtop500", "name": "TOP500", "bangid": "8888"},
    {"id": "kgwlhgb", "name": "网络榜", "bangid": "23784"},
    {"id": "kgbsb", "name": "飙升榜", "bangid": "6666"},
    {"id": "kgfxb", "name": "分享榜", "bangid": "21101"},
    {"id": "kgcyyb", "name": "纯音乐榜", "bangid": "33164"},
    {"id": "kggfjqb", "name": "古风榜", "bangid": "33161"},
    {"id": "kgyyjqb", "name": "粤语榜", "bangid": "33165"},
    {"id": "kgomjqb", "name": "欧美榜", "bangid": "33166"},
    {"id": "kgdyrgb", "name": "电音榜", "bangid": "33160"},
    {"id": "kgjdrgb", "name": "DJ热歌榜", "bangid": "24971"},
    {"id": "kghyxgb", "name": "华语新歌榜", "bangid": "31308"},
]

RANK_API = "http://mobilecdnbj.kugou.com/api/v3/rank/song"


def get_url(page: int, bangid: str, limit: int = LIST_DETAIL_LIMIT) -> str:
    return (
        f"{RANK_API}?version=9108&ranktype=1&plat=0&pagesize={limit}"
        f"&area_code=1&page={page}&rankid={bangid}&with_res_tag=0&show_portrait_mv=1"
    )


def _filter_data(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in raw_list:
        types: list[dict[str, Any]] = []
        _types: dict[str, dict[str, Any]] = {}
        for quality, size_key, hash_key in (
            ("128k", "filesize", "hash"),
            ("320k", "320filesize", "320hash"),
            ("flac", "sqfilesize", "sqhash"),
            ("flac24bit", "filesize_high", "hash_high"),
        ):
            if item.get(size_key, 0) == 0:
                continue
            size = size_formate(item.get(size_key))
            types.append({"type": quality, "size": size, "hash": item.get(hash_key)})
            _types[quality] = {"size": size, "hash": item.get(hash_key)}
        result.append(
            {
                "singer": _singer(item.get("authors")),
                "name": decode_name(item.get("songname")),
                "albumName": decode_name(item.get("remark")),
                "albumId": item.get("album_id"),
                "songmid": item.get("audio_id"),
                "source": "kg",
                "interval": format_play_time(item.get("duration")),
                "img": None,
                "lrc": None,
                "hash": item.get("hash"),
                "otherSource": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return result


def _singer(authors: list[dict[str, Any]] | None) -> str:
    names = [str(author["author_name"]) for author in authors or [] if author.get("author_name")]
    return decode_name("、".join(names))


async def get_boards() -> dict[str, Any]:
    return {"list": BOARD_LIST, "source": "kg"}


async def get_list(bangid: str, page: int = 1, retry_num: int = 0) -> dict[str, Any]:
    if retry_num > 3:
        raise RuntimeError("try max num")
    resp: Any
    try:
        resp = await http_fetch(get_url(page, bangid))
    except Exception:  # noqa: BLE001 - 可降级失败：换一次请求重试
        return await get_list(bangid, page, retry_num + 1)
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("errcode") != 0:
        return await get_list(bangid, page, retry_num + 1)
    data = body.get("data") or {}
    return {
        "total": data.get("total"),
        "list": _filter_data(data.get("info") or []),
        "limit": 100,
        "page": page,
        "source": "kg",
    }


def get_detail_page_url(id: Any) -> str:
    value = str(id).replace("kg__", "") if isinstance(id, str) else id
    return f"https://www.kugou.com/yy/rank/home/1-{value}.html"
