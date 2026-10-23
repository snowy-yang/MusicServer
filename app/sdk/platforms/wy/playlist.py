"""网易云歌单能力（移植自 sdk/wy/playlist.ts，上游 music-lib/netease/playlist.go）。

搜索/分类：复用 song_list（search=cloudsearch type1000、get_tag=catalogue、get_list=playlist/list）
推荐：weapi/personalized/playlist（匿名可用）
详情/曲目：复用 song_list.get_list_detail（linuxapi forward），按 page/limit 切片
链接解析：#/playlist?id= / /playlist?id= / /playlist/<id>/<n>/... / 裸数字 id
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import format_play_count
from app.sdk.platforms.wy import song_list
from app.sdk.platforms.wy.link import parse_netease_link
from app.sdk.platforms.wy.utils import weapi_headers
from app.sdk.platforms.wy.utils.crypto import weapi

PLAYLIST_LINK = "https://music.163.com/#/playlist?id={}"


def playlist_link(playlist_id: str) -> str:
    return PLAYLIST_LINK.format(playlist_id)


def api_limit() -> int:
    """catalogue/list 接口固定页大小（song_list.LIMIT_LIST 运行时读取，避免模块环上的顺序问题）。"""
    try:
        return int(song_list.LIMIT_LIST) or 30
    except (TypeError, ValueError):
        return 30


def to_summary(item: Any, category_id: str | None = None) -> dict[str, Any] | None:
    """歌单摘要：兼容 song_list 既有字段并补 spec 形状（id/name/cover/trackCount/creator/...）。"""
    if not isinstance(item, dict):
        return None
    id_ = str(item.get("id") or "").strip()
    if not id_:
        return None
    track_count = int(item.get("trackCount") or item.get("total") or 0)
    play_count = int(item.get("playCount") or 0)
    summary: dict[str, Any] = {
        **item,
        "id": id_,
        "name": item.get("name") or "",
        "cover": item.get("cover") or item.get("img") or "",
        "trackCount": track_count,
        "playCount": play_count,
        "play_count": item.get("play_count") or format_play_count(play_count),
        "creator": item.get("creator") or item.get("author") or "",
        "description": item.get("description") or item.get("desc") or "",
        "link": playlist_link(id_),
        "source": "wy",
    }
    if category_id:
        summary["categoryId"] = category_id
    return summary


async def search_playlist(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """歌单搜索（复用 song_list.search）。"""
    result = await song_list.search(str(keyword or ""), page, limit)
    rows = [summary for item in result.get("list") or [] if (summary := to_summary(item))]
    return {"list": rows, "page": page, "limit": limit, "total": result.get("total") or len(rows), "source": "wy"}


async def get_playlist_detail(playlist_id: str, page: int = 1, limit: int = 50) -> dict[str, Any]:
    """歌单详情（复用 song_list.get_list_detail，按 page/limit 切片）。"""
    detail = await song_list.get_list_detail(str(playlist_id or ""), 1)
    start = max(0, (page - 1) * limit)
    songs = detail.get("list") or []
    return {
        "source": "wy",
        "info": detail.get("info"),
        "list": songs[start : start + limit],
        "page": page,
        "limit": limit,
        "total": detail.get("total") or len(songs),
    }


async def get_playlist_songs(playlist_id: str) -> list[dict[str, Any]]:
    """歌单曲目全量（路由在详情签名不匹配时也会用这条兜底）。"""
    return list((await song_list.get_list_detail(str(playlist_id or ""), 1)).get("list") or [])


async def _safe(coro: Any) -> Any:
    """吞掉分类接口异常并退回空列表（原实现是 .catch(() => [])）。"""
    try:
        return await coro
    except Exception as err:  # noqa: BLE001 - 分类是可选增强，不应让整页 502
        print(f"[wy] 歌单分类接口失败（已降级为空）: {err}")
        return []


async def get_categories() -> dict[str, Any]:
    """歌单分类：摊平 catalogue + hottags，首项固定「全部」。单个接口失败不拖垮整体。"""
    groups, hot_tags = await asyncio.gather(_safe(song_list.get_tag()), _safe(song_list.get_hot_tag()))
    hot_set = {str(item.get("id")) for item in hot_tags or [] if isinstance(item, dict)}
    rows: list[dict[str, Any]] = [{"id": "", "name": "全部", "group": "全部"}]
    seen = {""}
    for group in groups or []:
        if not isinstance(group, dict):
            continue
        for item in group.get("list") or []:
            if not isinstance(item, dict):
                continue
            id_ = str(item.get("id") or "").strip()
            name = str(item.get("name") or "").strip()
            if not id_ or not name or id_ in seen:
                continue
            seen.add(id_)
            rows.append({"id": id_, "name": name, "group": group.get("name") or "", "hot": id_ in hot_set})
    return {"source": "wy", "list": rows}


async def get_category_playlists(category_id: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """分类歌单：接口每页 30 条，按入参 limit 重新切片。"""
    cat = str(category_id or "").strip() or "全部"
    start = max(0, (page - 1) * limit)
    page_size = api_limit()
    api_pages = max(1, -(-(start + limit) // page_size))  # ceil 除法

    items: list[dict[str, Any]] = []
    total = 0
    for api_page in range(1, api_pages + 1):
        result = await song_list.get_list("hot", cat, api_page)
        total = int(result.get("total") or total) or total
        batch = result.get("list") or []
        items.extend(batch)
        if len(batch) < page_size:
            break

    rows = [summary for item in items[start : start + limit] if (summary := to_summary(item, cat))]
    return {"list": rows, "page": page, "limit": limit, "total": total or len(items), "source": "wy"}


async def get_recommended(page: int = 1, limit: int = 20) -> dict[str, Any]:
    """推荐歌单（weapi/personalized/playlist）。"""
    resp = await http_fetch(
        "https://music.163.com/weapi/personalized/playlist",
        method="post",
        headers=weapi_headers(),
        form=weapi({"limit": 30, "total": True, "n": 1000}),
        timeout=15000,
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 200:
        raise RuntimeError(f"wy 推荐歌单获取失败 (code {body.get('code', resp.status_code)})")

    rows: list[dict[str, Any]] = []
    for item in body.get("result") or []:
        if not isinstance(item, dict):
            continue
        id_ = str(item.get("id") or "").strip()
        if not id_:
            continue
        play_count = int(item.get("playCount") or 0)
        copywriter = item.get("copywriter") or ""
        rows.append(
            {
                "id": id_,
                "name": item.get("name") or "",
                "cover": item.get("picUrl") or "",
                "trackCount": int(item.get("trackCount") or 0),
                "playCount": play_count,
                "play_count": format_play_count(play_count),
                "creator": copywriter or "网易云推荐",
                "description": copywriter,
                "link": playlist_link(id_),
                "alg": item.get("alg") or "",
                "source": "wy",
            }
        )
    if not rows:
        raise RuntimeError("no recommended playlists found")

    start = max(0, (page - 1) * limit)
    return {"list": rows[start : start + limit], "page": page, "limit": limit, "total": len(rows), "source": "wy"}


get_recommended_playlists = get_recommended


async def parse_playlist_link(link: str) -> dict[str, Any]:
    """歌单链接解析（裸数字 id 兜底）。"""
    raw = str(link or "").strip()
    if not raw:
        raise RuntimeError("无效的网易云歌单链接")
    if raw.isdigit():
        return await get_playlist_detail(raw)
    kind, id_ = parse_netease_link(raw)
    if kind != "playlist":
        raise RuntimeError("无效的网易云歌单链接")
    return await get_playlist_detail(id_)
