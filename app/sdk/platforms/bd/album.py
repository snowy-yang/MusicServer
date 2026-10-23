"""千千音乐专辑（对应 sdk/bd/album.ts）。

搜索：`/v1/search?type=3`（特殊字符触发 errno 23001 时用清洗后的关键词重试）。
详情：`/v1/album/info?albumAssetCode=P...`（P 码可直接用；纯数字旧 id 走
`/v1/album/albumid2psid` 转换）。
专辑链接：`https://music.91q.com/album/<albumAssetCode>`。
"""

from __future__ import annotations

import math
import re
from typing import Any

from app.sdk.platforms.bd.util import (
    APP_ID,
    album_link,
    api_get,
    api_ok,
    error_text,
    join_artists,
    map_track,
    normalize_album_asset_code,
    release_date10,
    sanitize_album_keyword,
    to_number,
)


class _RetryableAlbumError(RuntimeError):
    """专辑搜索失败；`retry_with_sanitized` 表示 23001（词非法）可换清洗后的词重试。"""

    def __init__(self, message: str, retry_with_sanitized: bool) -> None:
        super().__init__(message)
        self.retry_with_sanitized = retry_with_sanitized


def _map_album_summary(item: Any) -> dict[str, Any]:
    source = item if isinstance(item, dict) else {}
    id = normalize_album_asset_code(source.get("albumAssetCode"))
    track_list = source.get("trackList")
    return {
        "id": id,
        "name": str(source.get("title") or "").strip(),
        "cover": str(source.get("pic") or "").strip(),
        "trackCount": len(track_list) if isinstance(track_list, list) else 0,
        "creator": join_artists(source.get("artist")),
        "description": str(source.get("introduce") or "").strip(),
        "releaseDate": release_date10(source.get("releaseDate")),
        "genre": str(source.get("genre") or "").strip(),
        "lang": str(source.get("lang") or "").strip(),
        "link": album_link(id) if id else "",
        "source": "bd",
    }


async def _search_album_once(word: str, page: int = 1, limit: int = 10) -> list[Any]:
    body = await api_get(
        "/v1/search",
        {
            "word": word,
            "type": "3",
            "pageNo": str(max(1, page)),
            "pageSize": str(max(1, limit)),
            "appid": APP_ID,
        },
    )
    if not api_ok(body):
        errno = body.get("errno") if isinstance(body, dict) else None
        raise _RetryableAlbumError(error_text(body, "千千专辑搜索失败"), to_number(errno) == 23001)
    data = (body.get("data") if isinstance(body, dict) else None) or {}
    items = data.get("typeAlbum") if isinstance(data, dict) else None
    return list(items) if isinstance(items, list) else []


async def search_album_items(keyword: str, page: int = 1, limit: int = 10) -> list[Any]:
    """上游 searchAlbumItems：原词失败（23001）时用清洗后的关键词重试一次。"""
    words = [str(keyword if keyword is not None else "").strip()]
    sanitized = sanitize_album_keyword(keyword)
    if sanitized and sanitized != words[0]:
        words.append(sanitized)

    last_err: Exception | None = None
    for word in words:
        try:
            return await _search_album_once(word, page, limit)
        except _RetryableAlbumError as err:
            last_err = err
            # 仅 23001 允许换清洗后的词重试；其余错误（网络/服务端）直接上抛
            if not err.retry_with_sanitized:
                break
    if last_err is not None:
        raise last_err
    return []


async def search_album(keyword: str, page: int = 1, limit: int = 10) -> dict[str, Any]:
    """搜索专辑（返回歌单/专辑统一摘要形状）。"""
    word = str(keyword if keyword is not None else "").strip()
    if not word:
        return {"source": "bd", "list": [], "total": 0, "page": page, "limit": limit}

    items = await search_album_items(word, page, limit)
    list_out = [album for album in (_map_album_summary(item) for item in items) if album["id"]][:limit]
    return {"source": "bd", "list": list_out, "total": len(items), "page": page, "limit": limit}


async def resolve_album_asset_code(id: str) -> str:
    """旧数字专辑 id → PSID（P 码）；已是 P 码则原样返回。"""
    raw = str(id if id is not None else "").strip()
    if not raw:
        raise RuntimeError("千千专辑 id 为空")

    normalized = normalize_album_asset_code(raw)
    if normalized:
        return normalized

    body = await api_get("/v1/album/albumid2psid", {"albumid": raw, "appid": APP_ID})
    if not api_ok(body):
        raise RuntimeError(error_text(body, "千千专辑 id 转换失败"))
    data = body.get("data") if isinstance(body, dict) else None
    for item in data if isinstance(data, list) else []:
        if isinstance(item, dict):
            psid = normalize_album_asset_code(item.get("psid"))
            if psid:
                return psid
    raise RuntimeError("千千专辑 asset code 未找到")


async def _fetch_album_info(id: str) -> tuple[str, dict[str, Any]]:
    album_id = await resolve_album_asset_code(id)
    body = await api_get("/v1/album/info", {"albumAssetCode": album_id, "appid": APP_ID})
    if not api_ok(body):
        raise RuntimeError(error_text(body, "千千专辑详情获取失败"))
    data = (body.get("data") if isinstance(body, dict) else None) or {}
    if not normalize_album_asset_code(data.get("albumAssetCode") if isinstance(data, dict) else None):
        raise RuntimeError("千千专辑不存在或已下架")
    return album_id, data


async def get_album_detail(id: str, page: int = 1, limit: int = 30) -> dict[str, Any]:
    """专辑详情（统一形状；album/info 一次返回全部曲目，这里按 page/limit 切片）。"""
    album_id, data = await _fetch_album_info(id)
    title = str(data.get("title") or "").strip()
    cover = str(data.get("pic") or "").strip()
    creator = join_artists(data.get("artist"))
    all_tracks = data.get("trackList")
    tracks = list(all_tracks) if isinstance(all_tracks, list) else []

    songs: list[dict[str, Any]] = []
    for item in tracks:
        song = map_track(item, album_id=album_id, album_name=title, img=cover, singer=creator)
        if not song["songmid"]:
            continue
        # 专辑内曲目补上序号（上游 Extra.track / sort）；为 0 时不写该键，与 TS 的 undefined 一致
        sort = to_number(item.get("sort") if isinstance(item, dict) else None)
        if sort > 0:
            song["track"] = int(sort)
        songs.append(song)

    size = max(1, limit)
    start = (max(1, page) - 1) * size

    return {
        "source": "bd",
        "info": {
            "id": album_id,
            "name": title,
            "img": cover,
            "desc": str(data.get("introduce") or "").strip(),
            "author": creator,
            "releaseDate": release_date10(data.get("releaseDate")),
            "genre": str(data.get("genre") or "").strip(),
            "lang": str(data.get("lang") or "").strip(),
            "total": len(songs),
        },
        "list": songs[start : start + size],
        "page": page,
        "limit": limit,
        "total": len(songs),
        "allPage": math.ceil(len(songs) / size) or 1,
    }


async def get_album_songs(id: str) -> list[dict[str, Any]]:
    """上游 GetAlbumSongs：只取曲目列表。"""
    detail = await get_album_detail(id, 1, 10000)
    return detail["list"]


async def parse_album_link(link: str) -> dict[str, Any]:
    """上游 ParseAlbum：支持 P 码链接 / albumAssetCode= / albumid= 三种形态。"""
    raw = str(link if link is not None else "").strip()
    patterns = (
        re.compile(r"music\.91q\.com/album/([A-Za-z0-9]+)"),
        re.compile(r"albumAssetCode=([A-Za-z0-9]+)"),
        re.compile(r"albumid=(\d+)"),
    )
    for pattern in patterns:
        match = pattern.search(raw)
        if match:
            return await get_album_detail(match.group(1))
    raise RuntimeError("无效的千千专辑链接")
