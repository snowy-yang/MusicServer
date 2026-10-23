"""酷我歌单（对应 sdk/kw/playlist.ts）。

在 `song_list` 之上做统一形状：
  * `get_playlist_detail(id, page, limit)` —— 服务端 1000 条/页，本地按 page/limit 开窗
  * `get_playlist_songs(id)` —— 聚合全部页曲目
  * `search_playlist` / `get_categories` / `get_category_playlists` / `get_recommended`
推荐（getRcmPlayList）服务端 limit 固定 36，显式更小的 limit 在本地截断。
"""

from __future__ import annotations

import math
import re
from typing import Any

from app.sdk.platforms.kw import song_list

SERVER_PAGE_SIZE = song_list.SONG_LIMIT
MAX_SERVER_PAGES = 60

_ID_PATTERNS = (
    re.compile(r"playlist_detail/(\d+)"),
    re.compile(r"/playlist/(\d+)"),
    re.compile(r"playlistId=(\d+)"),
)
_DIGEST_PREFIX_RE = re.compile(r"^digest-\w+__")


def _js_number_or_raw(value: Any, default: Any = 0) -> Any:
    """复现 JS 的 `Number(x) → isFinite ? 数字 : 原值` 语义。

    `format_play_count` 返回的是 `"1.2万"` 这类字符串，`Number("1.2万")` 是 NaN，
    原实现于是把原字符串原样传下去；能解析成数字的才转成数字。
    """
    if value is None or value == "":
        return default
    try:
        num = float(value)
    except (TypeError, ValueError):
        return value
    if not math.isfinite(num):
        return value
    return int(num) if num.is_integer() else num


def _to_number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _to_int(value: Any) -> int:
    return int(_to_number(value))


def _first_non_empty(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def normalize_playlist_id(playlist_id: Any) -> str:
    """歌单链接 → 裸 id；digest 前缀形态原样保留（交给 song_list 分流）。"""
    raw = "" if playlist_id is None else str(playlist_id).strip()
    if not raw:
        return ""
    for pattern in _ID_PATTERNS:
        match = pattern.search(raw)
        if match:
            return match.group(1)
    return raw


def _to_summary(item: dict[str, Any]) -> dict[str, Any]:
    """歌单摘要：在原始条目上补齐契约要求的 id/name/cover/trackCount/… 字段。"""
    playlist_id = str(item.get("id") or "").strip()
    plain_id = _DIGEST_PREFIX_RE.sub("", playlist_id)
    return {
        **item,
        "id": playlist_id,
        "name": str(item.get("name") or "").strip(),
        "cover": _first_non_empty(item.get("img"), item.get("cover")),
        # 原实现用 `??` 而非 `||`，total 为 0 时不会退化到 trackCount
        "trackCount": _to_int(item["total"] if item.get("total") is not None else item.get("trackCount")) or 0,
        "playCount": _js_number_or_raw(item.get("play_count")),
        "creator": _first_non_empty(item.get("author"), item.get("creator"), item.get("uname")),
        "description": _first_non_empty(item.get("desc"), item.get("description")),
        "link": f"http://www.kuwo.cn/playlist_detail/{plain_id}" if plain_id else "",
        "source": "kw",
    }


def _windowed(result: dict[str, Any], page: int, limit: int) -> dict[str, Any]:
    """推荐/分类接口的 limit 由服务端固定，显式更小时本地截断。"""
    requested = _to_int(limit)
    server_limit = _to_int(result.get("limit"))
    songs = [item for item in (_to_summary(raw) for raw in result.get("list") or []) if item["id"]]
    if requested > 0 and len(songs) > requested:
        songs = songs[:requested]
    effective = min(requested, server_limit) if requested > 0 and server_limit > 0 else server_limit
    return {
        "source": "kw",
        "list": songs,
        "page": page,
        "limit": effective or len(songs),
        "total": _to_int(result.get("total")) or len(songs),
    }


async def search_playlist(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    word = str(keyword or "").strip()
    if not word:
        return {"source": "kw", "list": [], "page": page, "limit": limit, "total": 0}
    res = await song_list.search(word, page, limit)
    songs = [item for item in (_to_summary(raw) for raw in res.get("list") or []) if item["id"]]
    return {
        "source": "kw",
        "list": songs,
        "page": page,
        "limit": limit,
        "total": _to_int(res.get("total")) or len(songs),
    }


async def get_playlist_detail(playlist_id: str, page: int = 1, limit: int = 50) -> dict[str, Any]:
    raw_id = normalize_playlist_id(playlist_id)
    if not raw_id:
        raise RuntimeError("酷我歌单 id 为空")
    page_no = max(1, _to_int(page) or 1)
    page_size = max(1, _to_int(limit) or 50)
    start = (page_no - 1) * page_size

    server_page = start // SERVER_PAGE_SIZE + 1
    skip = start % SERVER_PAGE_SIZE
    songs: list[dict[str, Any]] = []
    info: dict[str, Any] | None = None
    total = 0
    while len(songs) < page_size and server_page <= MAX_SERVER_PAGES:
        res = await song_list.get_list_detail(raw_id, server_page)
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
        if len(raw_list) < SERVER_PAGE_SIZE:
            break
        if total > 0 and server_page * SERVER_PAGE_SIZE >= total:
            break
        server_page += 1

    info = info or {}
    return {
        "source": "kw",
        "info": {
            "name": _first_non_empty(info.get("name"), raw_id),
            "img": _first_non_empty(info.get("img")),
            "desc": _first_non_empty(info.get("desc")),
            "author": _first_non_empty(info.get("author")),
            "play_count": info.get("play_count", ""),
        },
        "list": songs,
        "page": page_no,
        "limit": page_size,
        "total": total or len(songs),
    }


async def get_playlist_songs(playlist_id: str) -> list[dict[str, Any]]:
    """聚合全部页曲目并按 songmid 去重。"""
    raw_id = normalize_playlist_id(playlist_id)
    if not raw_id:
        raise RuntimeError("酷我歌单 id 为空")
    songs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for server_page in range(1, MAX_SERVER_PAGES + 1):
        res = await song_list.get_list_detail(raw_id, server_page)
        raw_list = res.get("list") or []
        for song in raw_list:
            key = str(song.get("songmid") or "")
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            songs.append(song)
        total = _to_int(res.get("total"))
        if len(raw_list) < SERVER_PAGE_SIZE:
            break
        if total > 0 and len(songs) >= total:
            break
    return songs


async def get_categories() -> dict[str, Any]:
    tags_data = await song_list.get_tags()
    hot_ids = {str(item.get("id") or "") for item in tags_data.get("hotTag") or []}
    result: list[dict[str, Any]] = [{"id": "", "name": "全部", "group": "全部"}]
    for group in tags_data.get("tags") or []:
        for item in group.get("list") or []:
            tag_id = str(item.get("id") or "").strip()
            name = str(item.get("name") or "").strip()
            if not tag_id or not name:
                continue
            result.append(
                {
                    "id": tag_id,
                    "name": name,
                    "group": str(group.get("name") or "").strip() or "其他",
                    "hot": tag_id in hot_ids,
                }
            )
    return {"source": "kw", "list": result}


async def get_category_playlists(category_id: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    tag_id = str(category_id or "").strip()
    page_no = max(1, _to_int(page) or 1)
    res = await song_list.get_list("hot", tag_id or None, page_no)
    return _windowed(res, page_no, limit)


async def get_recommended(page: int = 1, limit: int = 30) -> dict[str, Any]:
    page_no = max(1, _to_int(page) or 1)
    res = await song_list.get_list("hot", None, page_no)
    return _windowed(res, page_no, limit)


async def parse_playlist_link(link: str) -> dict[str, Any]:
    raw = str(link or "")
    for pattern in _ID_PATTERNS:
        match = pattern.search(raw)
        if match:
            return await get_playlist_detail(match.group(1), 1)
    raise RuntimeError("无效的酷我歌单链接")


__all__ = [
    "get_categories",
    "get_category_playlists",
    "get_playlist_detail",
    "get_playlist_songs",
    "get_recommended",
    "normalize_playlist_id",
    "parse_playlist_link",
    "search_playlist",
]
