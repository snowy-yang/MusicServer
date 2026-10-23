"""QQ音乐歌单能力位（移植自 sdk/tx/playlist.ts）。

复用 song_list 的搜索/分类/详情，另补三块上游独有的逻辑：
  * 分类歌单按入参 limit 重新切片（上游固定 36 条一页，需多次拉取拼够）
  * 推荐歌单（musicu.fcg playlist.HotRecommendServer/get_hot_recommend）
  * 歌单链接解析（extract_playlist_id 支持现代 ryqq 路由 / 老版 id、disstid 查询，
    并显式拒绝歌曲/专辑链接，避免把其中的数字 id 误判成歌单）
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, urlparse

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import format_play_count
from app.sdk.platforms.tx import song_list
from app.sdk.platforms.tx.utils import MUSICU_URL

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
_API_LIMIT = song_list.LIMIT_LIST
_DIGITS = re.compile(r"^\d+$")
# 歌曲/专辑页特征：出现即拒绝（歌单链接可能带 ?id=，故先看是否含 playlist）
_NON_PLAYLIST = re.compile(r"(albumDetail|/album/|albummid=|songDetail|/song/|songmid=|[?&]songid=)")
_BARE_PLAYLIST_PATH = re.compile(r"(?:^|/)playlist/(\d+)(?:[/?#]|$)")


def _playlist_link(playlist_id: str) -> str:
    return f"https://y.qq.com/n/ryqq/playlist/{playlist_id}"


def _to_summary(item: Any) -> dict[str, Any] | None:
    """歌单摘要：兼容 song_list 的既有字段并补 spec 形状。"""
    if not isinstance(item, dict):
        return None
    playlist_id = str(item.get("id") or "").strip()
    if not playlist_id:
        return None
    cover = str(item.get("img") or item.get("cover") or "")
    track_count = item.get("total")
    return {
        **item,
        "id": playlist_id,
        "name": item.get("name") or "",
        "cover": cover,
        "trackCount": int(track_count) if isinstance(track_count, (int, float)) else 0,
        "creator": item.get("author") or item.get("creator") or "",
        "description": item.get("desc") or item.get("description") or "",
        "link": _playlist_link(playlist_id),
        "source": "tx",
    }


def _normalize_playlist_id(value: str) -> str:
    trimmed = str(value or "").strip()
    return trimmed if trimmed and _DIGITS.match(trimmed) else ""


def _filter_category_content(raw: Any) -> list[dict[str, Any]]:
    """分类内容 → 摘要（补 song_cnt/play_cnt，song_list.filter_list2 未映射这两个字段）。"""
    rows: list[dict[str, Any]] = []
    for item in raw or []:
        basic = (item or {}).get("basic") or {}
        playlist_id = str(basic.get("tid") or "").strip()
        name = str(basic.get("title") or "").strip()
        if not playlist_id or not name:
            continue
        play_count = basic.get("play_cnt") or 0
        cover = str((basic.get("cover") or {}).get("medium_url") or (basic.get("cover") or {}).get("default_url") or "")
        desc = str(basic.get("desc") or "").replace("<br>", "\n")
        track_count = basic.get("song_cnt") or 0
        rows.append(
            {
                "id": playlist_id,
                "name": name,
                "img": cover,
                "cover": cover,
                "author": (basic.get("creator") or {}).get("nick") or "",
                "creator": (basic.get("creator") or {}).get("nick") or "",
                "play_count": format_play_count(play_count),
                "playCount": int(play_count),
                "trackCount": int(track_count),
                "total": int(track_count),
                "desc": desc,
                "description": desc,
                "source": "tx",
            }
        )
    return rows


async def search_playlist(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """歌单搜索（复用 song_list.search）。"""
    result = await song_list.search(str(keyword or ""), page, limit)
    rows = [summary for summary in (_to_summary(item) for item in result.get("list") or []) if summary]
    total = result.get("total")
    return {"list": rows, "page": page, "limit": limit, "total": total or len(rows), "source": "tx"}


async def get_playlist_detail(playlist_id: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """歌单详情：详情接口返回全量曲目，这里按 page/limit 切片。"""
    detail = await song_list.get_list_detail(str(playlist_id or ""))
    songs = detail.get("list") or []
    start = max(0, (page - 1) * limit)
    total = detail.get("total")
    return {
        "source": "tx",
        "info": detail.get("info"),
        "list": songs[start : start + limit],
        "page": page,
        "limit": limit,
        "total": total if total is not None else len(songs),
    }


async def get_playlist_songs(playlist_id: str) -> list[dict[str, Any]]:
    detail = await song_list.get_list_detail(str(playlist_id or ""))
    return detail.get("list") or []


async def get_categories() -> dict[str, Any]:
    """歌单分类：分组标签 + 热门标记（单个接口失败不阻塞整体）。"""
    tags = await song_list.get_tags()
    groups = tags.get("tags") or []
    hot_tags = tags.get("hotTag") or []

    hot_set = {str(item.get("id")) for item in hot_tags if isinstance(item, dict)}
    rows: list[dict[str, Any]] = [{"id": "", "name": "全部", "group": "全部"}]
    seen = {""}
    for group in groups:
        for item in group.get("list") or []:
            category_id = str(item.get("id") or "").strip()
            name = str(item.get("name") or "").strip()
            if not category_id or not name or category_id in seen:
                continue
            seen.add(category_id)
            rows.append(
                {"id": category_id, "name": name, "group": group.get("name") or "", "hot": category_id in hot_set}
            )
    return {"source": "tx", "list": rows}


async def get_category_playlists(category_id: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """分类歌单。上游固定 36 条一页，按 (start+limit) 推算需要拉几页再切片。

    categoryId 为空或 '10000000'（上游「全部」默认值）时走 get_playlist_by_tag 广场分支。
    """
    category = str(category_id or "").strip()
    is_all = category in ("", "10000000")
    start = max(0, (page - 1) * limit)
    api_pages = max(1, -(-(start + limit) // _API_LIMIT))  # ceil 除法

    items: list[dict[str, Any]] = []
    total = 0
    for api_page in range(1, api_pages + 1):
        url = song_list.get_list_url("5", "" if is_all else category, api_page)
        resp = await http_fetch(url, timeout=15000)
        body = resp.body if isinstance(resp.body, dict) else {}
        if resp.status_code != 200 or body.get("code") != 0:
            raise RuntimeError(f"tx 分类歌单获取失败 (code {body.get('code') or resp.status_code})")
        data = (body.get("playlist") or {}).get("data") or {}
        if is_all:
            total = int(data.get("total") or total)
            batch = []
            for item in data.get("v_playlist") or []:
                play_count = item.get("access_num") or 0
                playlist_id = str(item.get("tid") or "").strip()
                name = str(item.get("title") or "").strip()
                if not playlist_id or not name:
                    continue
                batch.append(
                    {
                        "id": playlist_id,
                        "name": name,
                        "cover": str(item.get("cover_url_medium") or item.get("cover_url_big") or ""),
                        "creator": (item.get("creator_info") or {}).get("nick") or "",
                        "trackCount": len(item.get("song_ids") or []),
                        "playCount": int(play_count),
                        "play_count": format_play_count(play_count),
                        "description": str(item.get("desc") or "").replace("<br>", "\n"),
                    }
                )
            items.extend(batch)
        else:
            content = data.get("content") or {}
            total = int(content.get("total_cnt") or total)
            batch = _filter_category_content(content.get("v_item"))
            items.extend(batch)
        if len(batch) < _API_LIMIT:
            break

    rows = [summary for summary in (_to_summary(item) for item in items[start : start + limit]) if summary]
    return {"list": rows, "page": page, "limit": limit, "total": total or len(items), "source": "tx"}


async def get_recommended(page: int = 1, limit: int = 20) -> dict[str, Any]:
    """推荐歌单（playlist.HotRecommendServer/get_hot_recommend）。"""
    resp = await http_fetch(
        MUSICU_URL,
        method="post",
        headers={"User-Agent": _UA, "Referer": "https://y.qq.com/", "Content-Type": "application/json"},
        body={
            "comm": {"ct": 24},
            "recomPlaylist": {
                "method": "get_hot_recommend",
                "module": "playlist.HotRecommendServer",
                "param": {"async": 1, "cmd": 2},
            },
        },
        timeout=15000,
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 0:
        raise RuntimeError(f"tx 推荐歌单获取失败 (code {body.get('code') or resp.status_code})")

    rows: list[dict[str, Any]] = []
    for item in ((body.get("recomPlaylist") or {}).get("data") or {}).get("v_hot") or []:
        playlist_id = str(
            item.get("content_id") or item.get("dissid") or item.get("id") or item.get("tid") or ""
        ).strip()
        name = str(item.get("title") or item.get("dissname") or item.get("name") or "").strip()
        if not playlist_id or not name:
            continue
        cover = str(item.get("cover") or item.get("imgurl") or "")
        play_count = item.get("listen_num") or item.get("listennum") or 0
        rows.append(
            {
                "id": playlist_id,
                "name": name,
                "cover": cover.replace("http://", "https://", 1) if cover.startswith("http://") else cover,
                "trackCount": int(item.get("song_cnt") or item.get("song_count") or item.get("songnum") or 0),
                "playCount": int(play_count),
                "play_count": format_play_count(play_count),
                "creator": str(item.get("username") or (item.get("creator") or {}).get("nick") or "").strip(),
                "description": "",
                "link": _playlist_link(playlist_id),
                "source": "tx",
            }
        )
    if not rows:
        raise RuntimeError("no recommended playlists found")

    start = max(0, (page - 1) * limit)
    return {"list": rows[start : start + limit], "page": page, "limit": limit, "total": len(rows), "source": "tx"}


async def extract_playlist_id(link: str) -> str | None:
    """链接 → 数字歌单 id；非歌单链接返回 None。"""
    raw = str(link or "").strip()
    if not raw:
        return None

    try:
        parsed = urlparse(raw)
    except ValueError:
        parsed = None
    if parsed is not None and parsed.scheme:
        path = parsed.path.lower()
        if "playlist" in path:
            query = parse_qs(parsed.query)
            for key in ("id", "disstid", "dissid"):
                for value in query.get(key) or []:
                    found = _normalize_playlist_id(value)
                    if found:
                        return found
        parts = [part for part in parsed.path.strip("/").split("/") if part]
        for index, part in enumerate(parts):
            if part.lower() == "playlist" and index + 1 < len(parts):
                found = _normalize_playlist_id(parts[index + 1])
                if found:
                    return found

    match = _BARE_PLAYLIST_PATH.search(raw)
    return match.group(1) if match else None


async def parse_playlist_link(link: str) -> dict[str, Any]:
    """歌单链接解析：提取 disstid 后取详情；短链走 song_list.get_list_id 兜底。"""
    raw = str(link or "").strip()
    if not raw:
        raise RuntimeError("无效的QQ音乐歌单链接")
    if not re.search(r"playlist", raw, re.IGNORECASE) and _NON_PLAYLIST.search(raw):
        raise RuntimeError("无效的QQ音乐歌单链接")

    playlist_id = await extract_playlist_id(raw)
    if not playlist_id and not re.search(r"\d", raw):
        raise RuntimeError("无效的QQ音乐歌单链接")
    if not playlist_id:
        try:
            playlist_id = await song_list.get_list_id(raw)
        except (RuntimeError, OSError, TimeoutError):
            playlist_id = ""
    if not playlist_id:
        raise RuntimeError("无效的QQ音乐歌单链接")
    return await get_playlist_detail(playlist_id)


get_recommended_playlists = get_recommended
