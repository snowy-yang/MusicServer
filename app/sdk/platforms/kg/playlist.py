"""酷狗歌单模块（对应 sdk/kg/playlist.ts）—— 统一形状层。

解析链复用 song_list 的能力（special/single、songlist/gcid、share chain、zlist、
global_collection_id 等），本模块只做形状归一：摘要 / 详情 / 分类 / 分类歌单 / 推荐 / 链接解析。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.kg import song_list

_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
)


def _first_non_empty(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _playlist_cover(url: Any) -> str:
    return str(url or "").replace("{size}", "240")


def _to_summary(item: dict[str, Any]) -> dict[str, Any] | None:
    raw_id = _first_non_empty(item.get("specialid"), item.get("global_specialid"), item.get("id"))
    playlist_id = re.sub(r"^id_", "", raw_id)
    if not playlist_id:
        return None
    play_count = _finite(item.get("playcount"))
    return {
        "id": playlist_id,
        "name": _first_non_empty(item.get("specialname"), item.get("name")),
        "cover": _playlist_cover(_first_non_empty(item.get("imgurl"), item.get("img"))),
        "trackCount": int(item.get("songcount") or item.get("total") or 0) or 0,
        "playCount": play_count if play_count is not None else (item.get("play_count") or 0),
        "creator": _first_non_empty(item.get("nickname"), item.get("username"), item.get("author")),
        "description": _first_non_empty(item.get("intro"), item.get("desc")),
        "publishTime": str(item.get("publishtime") or item.get("time") or "").strip(),
        "link": f"https://www.kugou.com/yy/special/single/{playlist_id}.html",
        "source": "kg",
    }


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def _normalize_playlist_id(id: Any) -> str:
    """数字 id / id_ 前缀 / 链接 → song_list.get_list_detail 可识别的入参。"""
    raw = str(id or "").strip()
    if not raw:
        return ""
    return f"id_{raw}" if re.fullmatch(r"\d+", raw) else raw


def _parse_category_id(category_id: Any) -> tuple[str, str]:
    parts = str(category_id or "").strip().split(":")
    return str(parts[0] if parts else "").strip(), (str(parts[1]).strip() if len(parts) > 1 else "") or "0"


async def search_playlist(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    word = str(keyword or "").strip()
    if not word:
        return {"source": "kg", "list": [], "page": page, "limit": limit, "total": 0}
    res = await song_list.search(word, page, limit)
    items = [summary for summary in (_to_summary(item) for item in res.get("list") or []) if summary]
    return {
        "source": "kg",
        "list": items,
        "page": page,
        "limit": limit,
        "total": int(res.get("total") or 0) or len(items),
    }


async def get_playlist_detail(playlist_id: str, page: int = 1, limit: int = 50) -> dict[str, Any]:
    request_id = _normalize_playlist_id(playlist_id)
    if not request_id:
        raise RuntimeError("酷狗歌单 id 为空")
    page_no = max(1, int(page or 1))
    page_size = max(1, int(limit or 50))

    res = await song_list.get_list_detail(request_id, page_no)
    if not res:
        raise RuntimeError("酷狗歌单不存在或解析失败")
    songs: list[dict[str, Any]] = res.get("list") or []
    total = int(res.get("total") or 0) or len(songs)
    if len(songs) > page_size:
        start = (page_no - 1) * page_size
        songs = songs[start : start + page_size]

    info = res.get("info") or {}
    return {
        "source": "kg",
        "info": {
            "name": _first_non_empty(info.get("name"), str(playlist_id)),
            "img": _playlist_cover(info.get("img")),
            "desc": _first_non_empty(info.get("desc")),
            "author": _first_non_empty(info.get("author")),
            "play_count": info.get("play_count") or "",
        },
        "list": songs,
        "page": page_no,
        "limit": page_size,
        "total": total,
    }


async def get_playlist_songs(playlist_id: str) -> list[dict[str, Any]]:
    res = await song_list.get_list_detail(_normalize_playlist_id(playlist_id), 1)
    return (res or {}).get("list") or []


async def get_categories() -> dict[str, Any]:
    resp = await http_fetch(
        "http://mobilecdnbj.kugou.com/api/v3/tag/list?pid=0&apiver=2&plat=0",
        headers={"User-Agent": _UA, "Referer": "http://m.kugou.com"},
        timeout=15000,
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("status") != 1 or body.get("errcode") != 0:
        raise RuntimeError(str(body.get("error") or "酷狗歌单分类获取失败"))

    items: list[dict[str, Any]] = [{"id": "", "name": "全部", "group": "全部"}]
    for group in (body.get("data") or {}).get("info") or []:
        group_name = str(group.get("name") or "").strip()
        group_id = int(group.get("id") or 0) or 0
        if group_id > 0 and group_name:
            items.append({"id": f"{group_id}:0", "name": group_name, "group": group_name})
        for child in group.get("children") or []:
            child_id = int(child.get("id") or 0) or 0
            child_name = str(child.get("name") or "").strip()
            if not child_id or not child_name:
                continue
            tag_id = int(child.get("special_tag_id") or 0) or 0
            items.append(
                {
                    "id": f"{child_id}:{tag_id}",
                    "name": child_name,
                    "group": group_name,
                    "hot": int(child.get("is_hot") or 0) == 1,
                }
            )
    return {"source": "kg", "list": items}


async def get_category_playlists(category_id: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    page_no = max(1, int(page or 1))
    page_size = max(1, int(limit or 20))

    category, tag_id = _parse_category_id(category_id)
    if not category:
        listing = await get_categories()
        first = next((item for item in listing["list"] if item.get("id")), None)
        if not first:
            raise RuntimeError("酷狗歌单分类为空")
        category, tag_id = _parse_category_id(first["id"])

    api_url = "http://mobilecdnbj.kugou.com/api/v3/tag/specialList?" + "&".join(
        ["plat=0", f"page={page_no}", f"tagid={tag_id}", f"pagesize={page_size}", "ugc=1", f"id={category}", "sort=2"]
    )
    resp = await http_fetch(api_url, headers={"User-Agent": _UA, "Referer": "http://m.kugou.com"}, timeout=15000)
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("status") != 1 or body.get("errcode") != 0:
        raise RuntimeError(str(body.get("error") or "酷狗分类歌单获取失败"))

    items: list[dict[str, Any]] = []
    for entry in (body.get("data") or {}).get("info") or []:
        summary = _to_summary(entry) or _to_summary({**entry, "specialid": entry.get("global_specialid")})
        if not summary:
            continue
        summary["categoryId"] = f"{category}:{tag_id}"
        items.append(summary)
    return {
        "source": "kg",
        "list": items,
        "page": page_no,
        "limit": page_size,
        "total": int((body.get("data") or {}).get("total") or 0) or len(items),
    }


async def get_recommended(page: int = 1, limit: int = 30) -> dict[str, Any]:
    page_no = max(1, int(page or 1))
    page_size = max(1, int(limit or 30))
    resp = await http_fetch(
        f"http://m.kugou.com/plist/index&json=true&page={page_no}",
        headers={"User-Agent": _UA, "Referer": "http://m.kugou.com"},
        timeout=15000,
    )
    body = resp.body if isinstance(resp.body, dict) else None
    if resp.status_code != 200 or not isinstance(body, dict):
        raise RuntimeError("酷狗推荐歌单获取失败")
    plist = (body.get("plist") or {}).get("list") or {}
    items = [summary for summary in (_to_summary(item) for item in plist.get("info") or []) if summary]
    if len(items) > page_size:
        items = items[:page_size]
    return {
        "source": "kg",
        "list": items,
        "page": page_no,
        "limit": page_size,
        "total": int(plist.get("total") or 0) or len(items),
    }


async def parse_playlist_link(link: str) -> dict[str, Any]:
    """special/single/<id>.html 与 songlist/<gcid_xxx>/ 优先，其余交给 song_list 通用解析。"""
    raw = str(link or "").strip()
    if not raw:
        raise RuntimeError("无效的酷狗歌单链接")
    special = re.search(r"special/single/(\d+)\.html", raw)
    if special:
        return await get_playlist_detail(special.group(1), 1)
    gcid = re.search(r"songlist/(gcid_[A-Za-z0-9]+)", raw)
    if gcid:
        return await get_playlist_detail(gcid.group(1), 1)
    return await get_playlist_detail(raw, 1)
