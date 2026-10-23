"""酷我专辑（对应 sdk/kw/album.ts）。

上游 `search.kuwo.cn/r.s?stype=albuminfo` 返回伪 JSON（单引号），服务端固定
1000 条/页。对外两个入口：
  * `get_album_list_detail(id, page)` —— 单页直取，第三参数是 retry_num
  * `get_album_detail(id, page, limit)` —— 统一形状，limit 小于 1000 时本地开窗
路由按 hasattr 分流（`app/routes/music.py:584`），两个名字都要提供。
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import decode_name
from app.sdk.platforms.kw.util import format_singer, obj_str2json

LIST_LIMIT = 36
SONG_LIMIT = 1000
# 本地开窗最多翻到第 50 个服务端页，避免异常 total 导致长循环
MAX_SERVER_PAGES = 50

DETAIL_API = (
    "http://search.kuwo.cn/r.s?pn={pn}&rn={rn}&stype=albuminfo&albumid={id}"
    "&show_copyright_off=0&encoding=utf&vipver=MUSIC_9.1.0"
)
SEARCH_API = (
    "http://search.kuwo.cn/r.s?all={keyword}&ft=album&itemset=web_2013&client=kt"
    "&pcmp4=1&geo=c&vipver=1&pn={pn}&rn={rn}&rformat=json&encoding=utf8"
)

# `formats` 字段是 `|` 分隔的音质标记；这里只认对外暴露的四个档位
_FORMAT_QUALITY = (
    ("MP3128", "128k"),
    ("MP3H", "320k"),
    ("ALFLAC", "flac"),
    ("HIRFLAC", "flac24bit"),
)


def _to_int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _first_non_empty(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _filter_list_detail(raw_list: list[dict[str, Any]], album_name: str, album_id: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in raw_list:
        formats = str(item.get("formats") or "").split("|")
        types: list[dict[str, Any]] = []
        _types: dict[str, dict[str, Any]] = {}
        for marker, quality in _FORMAT_QUALITY:
            if marker not in formats:
                continue
            types.append({"type": quality, "size": None})
            _types[quality] = {"size": None}
        result.append(
            {
                "singer": format_singer(decode_name(item.get("artist"))),
                "name": decode_name(item.get("name")),
                "albumName": album_name,
                "albumId": album_id,
                "songmid": item.get("id"),
                "source": "kw",
                # 专辑接口不返回时长/封面，宁可为空也不猜
                "interval": None,
                "img": item.get("pic"),
                "lrc": None,
                "otherSource": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return result


async def get_album_list_detail(album_id: str, page: int = 1, retry_num: int = 0) -> dict[str, Any]:
    if retry_num > 2:
        raise RuntimeError("try max num")
    url = DETAIL_API.format(pn=page - 1, rn=SONG_LIMIT, id=album_id)
    resp = await http_fetch(url)
    if resp.status_code != 200:
        return await get_album_list_detail(album_id, page, retry_num + 1)
    body = obj_str2json(resp.raw.decode("utf-8", errors="replace"))
    if not body.get("musiclist"):
        return await get_album_list_detail(album_id, page, retry_num + 1)

    album_name = decode_name(body.get("name"))
    return {
        "list": _filter_list_detail(body["musiclist"], album_name, body.get("albumid")),
        "page": page,
        "limit": SONG_LIMIT,
        "total": _to_int(body.get("songnum")),
        "source": "kw",
        "info": {
            "name": album_name,
            "img": body.get("img") or body.get("hts_img"),
            "desc": decode_name(body.get("info")),
            "author": decode_name(body.get("artist")),
        },
    }


async def get_album_detail(album_id: str, page: int = 1, limit: int = 1000) -> dict[str, Any]:
    """统一形状的专辑详情。limit >= 1000 时服务端页大小够用，直通单页接口。"""
    album_key = str(album_id or "").strip()
    if not album_key:
        raise RuntimeError("酷我专辑 id 为空")
    page_no = max(1, _to_int(page) or 1)
    page_size = max(1, _to_int(limit) or SONG_LIMIT)
    if page_size >= SONG_LIMIT:
        return await get_album_list_detail(album_key, page_no)

    start = (page_no - 1) * page_size
    server_page = start // SONG_LIMIT + 1
    skip = start % SONG_LIMIT
    songs: list[dict[str, Any]] = []
    info: dict[str, Any] | None = None
    total = 0
    while len(songs) < page_size and server_page <= MAX_SERVER_PAGES:
        res = await get_album_list_detail(album_key, server_page)
        if not res:
            break
        if info is None:
            info = res.get("info")
        total = _to_int(res.get("total")) or total
        raw_list = res.get("list") or []
        if not raw_list:
            break
        songs.extend(raw_list[skip : skip + (page_size - len(songs))])
        skip = 0
        if len(raw_list) < SONG_LIMIT:
            break
        if total > 0 and len(songs) >= total:
            break
        server_page += 1

    return {
        "source": "kw",
        "info": info or {"name": album_key, "img": "", "desc": "", "author": ""},
        "list": songs,
        "page": page_no,
        "limit": page_size,
        "total": total or len(songs),
    }


async def get_album_songs(album_id: str) -> list[dict[str, Any]]:
    """聚合全部分页曲目并按 songmid 去重。"""
    album_key = str(album_id or "").strip()
    if not album_key:
        raise RuntimeError("酷我专辑 id 为空")
    songs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in range(1, MAX_SERVER_PAGES + 1):
        res = await get_album_list_detail(album_key, page)
        raw_list = res.get("list") or []
        for song in raw_list:
            key = str(song.get("songmid") or "")
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            songs.append(song)
        total = _to_int(res.get("total"))
        if len(raw_list) < SONG_LIMIT:
            break
        if total > 0 and len(songs) >= total:
            break
    return songs


async def search_album(keyword: str, page: int = 1, limit: int = 10) -> dict[str, Any]:
    word = str(keyword or "").strip()
    if not word:
        return {"source": "kw", "list": [], "page": page, "limit": limit, "total": 0}
    page_no = max(1, _to_int(page) or 1)
    page_size = max(1, _to_int(limit) or 10)

    resp = await http_fetch(SEARCH_API.format(keyword=quote(word, safe=""), pn=page_no - 1, rn=page_size))
    if resp.status_code != 200:
        raise RuntimeError("酷我专辑搜索失败")
    text = resp.raw.decode("utf-8", errors="replace")
    try:
        data = obj_str2json(text)
    except Exception as err:
        raise RuntimeError("酷我专辑搜索失败") from err
    if not data.get("albumlist"):
        raise RuntimeError("酷我专辑搜索失败")

    result: list[dict[str, Any]] = []
    for item in data["albumlist"]:
        album_key = _first_non_empty(item.get("albumid"), item.get("id"))
        if not album_key:
            continue
        result.append(
            {
                "id": album_key,
                "name": decode_name(_first_non_empty(item.get("name"))),
                "cover": _first_non_empty(item.get("hts_img"), item.get("img")),
                "trackCount": _to_int(item.get("musiccnt")),
                "playCount": _to_int(item.get("PLAYCNT") or item.get("playcnt")),
                "creator": decode_name(_first_non_empty(item.get("aartist"), item.get("artist"))),
                "description": decode_name(_first_non_empty(item.get("info"))),
                "link": f"http://www.kuwo.cn/album_detail/{album_key}",
                "source": "kw",
                "type": "album",
                "company": decode_name(_first_non_empty(item.get("company"))),
                "publishTime": _first_non_empty(item.get("pub")),
            }
        )
    return {
        "source": "kw",
        "list": result,
        "page": page_no,
        "limit": page_size,
        "total": _to_int(data.get("TOTAL") or data.get("total")) or len(result),
    }


async def parse_album_link(link: str) -> dict[str, Any]:
    raw = str(link or "")
    for pattern in (r"album_detail/(\d+)", r"album/(\d+)", r"albumid=(\d+)"):
        match = re.search(pattern, raw)
        if match:
            return await get_album_detail(match.group(1), 1)
    raise RuntimeError("无效的酷我专辑链接")


__all__ = [
    "get_album_detail",
    "get_album_list_detail",
    "get_album_songs",
    "parse_album_link",
    "search_album",
]
