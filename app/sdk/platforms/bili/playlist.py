"""Bilibili 歌单（对应 sdk/bili/playlist.ts，上游 bilibili/playlist.go）。

B 站的「歌单」= 合集 ugc_season / 多分P稿件：
  * search_playlist: 用视频搜索 + view 判断，把「合集」和「多分P稿件」当歌单返回；
  * get_playlist_detail / parse_playlist_link: id 约定 ``season:<season_id>:<mid>:<bvid>`` 或 ``bvid:<bvid>``；
  * get_categories / get_category_playlists: 上游显式返回 ErrPlaylistCategoriesUnsupported，保持不支持（抛错）。

注意：上游用于补全合集信息的 x/space/ugc/season 接口现已 404，bvid 路径（view 内自带 sections）是主通道。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.platforms.bili.music_search import SEARCH_URL
from app.sdk.platforms.bili.util import (
    api_get,
    as_dict,
    as_list,
    build_songs_from_pages,
    build_songs_from_season_sections,
    clean_title,
    encode_uri_component,
    extract_aid,
    extract_bvid,
    fetch_page_list,
    fetch_season_archive_index,
    fetch_season_songs,
    fetch_view,
    map_limit,
    normalize_cover,
    to_number,
)


def _count_season_episodes(sections: list[Any]) -> int:
    count = 0
    for sec in sections or []:
        if isinstance(sec, dict):
            episodes = sec.get("episodes")
            count += len(episodes) if isinstance(episodes, list) else 0
    return count


def _season_key(season_id: Any, mid: Any, bvid: str) -> str:
    return f"season:{season_id}:{mid}:{bvid}"


def _bvid_key(bvid: str) -> str:
    return f"bvid:{bvid}"


async def search_playlist(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """搜索合集/多分P（上游 SearchPlaylist；page/limit 为移植新增的翻页能力）。"""
    p = max(1, int(to_number(page)) or 1)
    size = min(max(1, int(to_number(limit)) or 20), 50)
    url = f"{SEARCH_URL}?search_type=video&keyword={encode_uri_component(keyword)}&page={p}&page_size={size}"
    resp = await api_get(url)
    body = resp.body
    if resp.status_code != 200 or not isinstance(body, dict):
        raise RuntimeError(f"B站歌单搜索失败（HTTP {resp.status_code}）")
    if body.get("code") != 0:
        message = body.get("message")
        raise RuntimeError(f"B站歌单搜索失败（{body.get('code')}{f': {message}' if message else ''}）")

    data = as_dict(body.get("data"))
    items = as_list(data.get("result"))
    seen: set[str] = set()

    async def one(item: Any, _index: int) -> dict[str, Any] | None:
        if not isinstance(item, dict) or not item.get("bvid"):
            return None
        view = await fetch_view(item["bvid"])
        cover = normalize_cover(item.get("pic") or view.get("pic") or "")
        owner = as_dict(view.get("owner"))
        season = as_dict(view.get("ugc_season")) or None
        if season:
            playlist_id = _season_key(season.get("id"), owner.get("mid"), str(item["bvid"]))
            if playlist_id in seen:
                return None
            seen.add(playlist_id)
            sections = as_list(season.get("sections"))
            track_count = _count_season_episodes(sections)
            if not track_count and season.get("id") and owner.get("mid"):
                try:
                    track_count = len(await fetch_season_songs(owner.get("mid"), season.get("id")))
                except Exception:  # noqa: BLE001 - 上游 fetchSeasonSongs 失败同样保持 trackCount 0
                    pass
            stat = as_dict(season.get("stat"))
            return {
                "id": playlist_id,
                "name": str(season.get("title") or clean_title(item.get("title"))),
                "cover": normalize_cover(season.get("cover")) or cover,
                "trackCount": track_count,
                "playCount": int(to_number(stat.get("view"))) or None,
                "creator": str(owner.get("name") or item.get("author") or ""),
                "description": str(season.get("intro") or ""),
                "link": f"https://www.bilibili.com/video/{item['bvid']}",
                "source": "bili",
            }
        pages = as_list(view.get("pages"))
        if len(pages) > 1:
            playlist_id = _bvid_key(str(item["bvid"]))
            if playlist_id in seen:
                return None
            seen.add(playlist_id)
            return {
                "id": playlist_id,
                "name": clean_title(item.get("title")),
                "cover": cover,
                "trackCount": len(pages),
                "creator": str(owner.get("name") or item.get("author") or ""),
                "description": "",
                "link": f"https://www.bilibili.com/video/{item['bvid']}",
                "source": "bili",
            }
        return None

    result = await map_limit(items, 4, one)
    result_list = [item for item in result if item]
    return {"list": result_list, "page": p, "limit": size, "total": len(result_list), "source": "bili"}


async def _detail_from_bvid(bvid: str) -> dict[str, Any]:
    """由 bvid 构造歌单详情（上游 GetPlaylistSongs 的 bvid 分支 + ParsePlaylist 的元数据）。"""
    view = await fetch_view(bvid)
    real_bvid = str(view.get("bvid") or bvid)
    pages = as_list(view.get("pages"))
    if len(pages) <= 1:
        try:
            page_list = await fetch_page_list(real_bvid)
        except Exception:  # noqa: BLE001 - 分P列表接口失败按上游语义忽略
            page_list = []
        if page_list:
            pages = page_list
    if not pages:
        raise RuntimeError("未找到视频分P")
    owner = as_dict(view.get("owner"))
    songs = build_songs_from_pages(
        real_bvid, str(view.get("title") or ""), str(owner.get("name") or ""), str(view.get("pic") or ""), pages
    )
    return {
        "info": {
            "name": str(view.get("title") or real_bvid),
            "img": normalize_cover(view.get("pic") or ""),
            "desc": str(view.get("desc") or ""),
            "author": str(owner.get("name") or ""),
        },
        "songs": songs,
    }


async def _detail_from_season(season_id: str, mid: str, bvid: str) -> dict[str, Any]:
    """由 ``season:<season_id>:<mid>:<bvid>`` 构造歌单详情（上游 GetPlaylistSongs 的 season 分支）。"""
    info: dict[str, Any] = {"name": "", "img": "", "desc": "", "author": ""}
    songs: list[dict[str, Any]] = []

    if bvid:
        view = await fetch_view(bvid)
        season = as_dict(view.get("ugc_season")) or None
        if season:
            archive_index: dict[str, dict[str, Any]] = {}
            season_title = str(season.get("title") or "")
            season_cover = str(season.get("cover") or "")
            # 上游会先拉 archive 索引补全缺失字段；该接口现已 404，失败时按空索引继续
            try:
                idx = await fetch_season_archive_index(mid, season_id)
            except Exception:  # noqa: BLE001
                idx = None
            if idx:
                archive_index = idx["index"]
                season_title = season_title or idx["title"]
                season_cover = season_cover or idx["cover"]
            owner = as_dict(view.get("owner"))
            songs = build_songs_from_season_sections(
                as_list(season.get("sections")),
                season_title,
                season_cover,
                str(owner.get("name") or ""),
                archive_index,
            )
            info = {
                "name": season_title or str(view.get("title") or ""),
                "img": normalize_cover(season_cover or view.get("pic") or ""),
                "desc": str(season.get("intro") or ""),
                "author": str(owner.get("name") or ""),
            }

    if not songs:
        songs = await fetch_season_songs(mid, season_id)
        if not info["name"]:
            try:
                idx = await fetch_season_archive_index(mid, season_id)
            except Exception:  # noqa: BLE001
                idx = None
            if idx:
                info = {**info, "name": idx["title"] or "", "img": normalize_cover(idx["cover"] or "")}
    if not songs:
        raise RuntimeError("合集为空或合集接口不可用")
    return {"info": info, "songs": songs}


async def _resolve_id(playlist_id: str) -> dict[str, Any]:
    """解析 id（兼容链接/裸 BV/av/bvid: 前缀）。"""
    raw = str(playlist_id or "").strip()
    if re.match(r"^https?:", raw, re.IGNORECASE):
        return {"kind": "link", "value": raw}
    if re.match(r"^season:", raw, re.IGNORECASE):
        return {"kind": "season", "value": raw, "parts": raw.split(":")}
    # 注意先去 `bvid:` 前缀再提 BV：大小写不敏感的 BV 匹配会把前缀 "bvid" 本身当成 BV 号
    bvid = extract_bvid(re.sub(r"^bvid:", "", raw, flags=re.IGNORECASE))
    if bvid:
        return {"kind": "bvid", "value": bvid}
    aid = extract_aid(raw)
    if aid:
        view = await fetch_view(aid)
        real_bvid = str(view.get("bvid") or "")
        if not real_bvid:
            raise RuntimeError("未找到视频 BV 号")
        return {"kind": "bvid", "value": real_bvid}
    raise RuntimeError("无效的歌单 id（支持 season:<season_id>:<mid>:<bvid>、bvid:<bvid> 或 BV 号/链接）")


def _page_slice(detail: dict[str, Any], page: Any, limit: Any) -> dict[str, Any]:
    p = max(1, int(to_number(page)) or 1)
    size = min(max(1, int(to_number(limit)) or 100), 10000)
    songs = detail["songs"]
    return {
        "source": "bili",
        "info": detail["info"],
        "list": songs[(p - 1) * size : p * size],
        "page": p,
        "limit": size,
        "total": len(songs),
    }


async def get_playlist_detail(playlist_id: str, page: int = 1, limit: int = 100) -> dict[str, Any]:
    """歌单详情（契约键 playlist.get_playlist_detail）。"""
    target = await _resolve_id(playlist_id)
    if target["kind"] == "link":
        return await parse_playlist_link(target["value"])
    if target["kind"] == "season":
        parts = target.get("parts") or []
        if len(parts) < 3:
            raise RuntimeError("无效的合集 id")
        bvid = parts[3] if len(parts) > 3 else ""
        return _page_slice(await _detail_from_season(parts[1], parts[2], bvid), page, limit)
    return _page_slice(await _detail_from_bvid(target["value"]), page, limit)


async def get_playlist_songs(playlist_id: str) -> list[dict[str, Any]]:
    """上游 GetPlaylistSongs 的等价导出（只返回歌曲数组）。"""
    detail = await get_playlist_detail(playlist_id, 1, 10000)
    return detail["list"]


async def parse_playlist_link(link: str) -> dict[str, Any]:
    """解析合集/多分P链接（上游 ParsePlaylist；返回详情对象，list 为全量）。"""
    raw = str(link or "").strip()
    bvid = extract_bvid(re.sub(r"^bvid:", "", raw, flags=re.IGNORECASE))
    if not bvid:
        aid = extract_aid(raw)
        if not aid:
            raise RuntimeError("无效的B站歌单链接：未找到 BV/av 号")
        view = await fetch_view(aid)
        return await _parse_playlist_view(str(view.get("bvid") or ""), view)
    view = await fetch_view(bvid)
    return await _parse_playlist_view(bvid, view)


async def _parse_playlist_view(bvid: str, view: dict[str, Any]) -> dict[str, Any]:
    owner = as_dict(view.get("owner"))
    season = as_dict(view.get("ugc_season")) or None
    if season:
        playlist_id = _season_key(season.get("id"), owner.get("mid"), bvid)
        detail = await _detail_from_season(
            str(season.get("id")), str(owner.get("mid") if owner.get("mid") is not None else ""), bvid
        )
        sections = as_list(season.get("sections"))
        track_count = _count_season_episodes(sections)
        if not track_count:
            track_count = len(detail["songs"])
        stat = as_dict(season.get("stat"))
        return {
            "source": "bili",
            "id": playlist_id,
            "info": {
                **detail["info"],
                "trackCount": track_count,
                "playCount": int(to_number(stat.get("view"))) or None,
            },
            "list": detail["songs"],
            "page": 1,
            "limit": max(len(detail["songs"]), 1),
            "total": len(detail["songs"]),
        }
    detail = await _detail_from_bvid(bvid)
    return {
        "source": "bili",
        "id": _bvid_key(bvid),
        "info": {**detail["info"], "trackCount": len(detail["songs"])},
        "list": detail["songs"],
        "page": 1,
        "limit": max(len(detail["songs"]), 1),
        "total": len(detail["songs"]),
    }


async def get_categories() -> dict[str, Any]:
    """上游 GetPlaylistCategories 返回 ErrPlaylistCategoriesUnsupported。"""
    raise RuntimeError("B站不支持歌单分类（上游未实现）")


async def get_category_playlists(_category_id: str, _page: int = 1, _limit: int = 20) -> dict[str, Any]:
    """上游 GetCategoryPlaylists 返回 ErrPlaylistCategoriesUnsupported。"""
    raise RuntimeError("B站不支持歌单分类（上游未实现）")
