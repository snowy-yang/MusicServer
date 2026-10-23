"""5sing 歌单（对应 sdk/5sing/playlist.ts，上游 fivesing/fivesing.go + playlist.go）。

搜索: GET http://search.5sing.kugou.com/home/json?...&type=1 → list[].songListId/title/...
      上游对 userName 为空的条目再调 getsonglist?songfields=user 补创建者名（并发 10）；本移植并发 5。
详情: ① GET mobileapi.5sing.kugou.com/song/getsonglist?id=&songfields=ID,user（元数据 T/C/P/H/E + user.ID/NN）
      ② 抓 http://5sing.kugou.com/{userId}/dj/{id}.html 解析 <li class="p_rel"> 块
      ③ 数字 userId 页会 302 到个性域名页，fetch_5sing 已手动跟跳。
分类/个人歌单：上游显式返回不支持，本移植保留同样语义（抛错）。
链接解析: 上游正则只认数字 userId；本移植放宽支持个性域名与省略 user 段，ID 以 API 反查为准。
"""

from __future__ import annotations

import asyncio
import math
import re
from typing import Any

from app.sdk.common.utils import as_dict, as_list
from app.sdk.platforms.fivesing.util import (
    MOBILE_API,
    SEARCH_API,
    build_playlist_link,
    build_song_link,
    encode_uri_component,
    extract_playlist_link,
    fetch_5sing,
    fetch_5sing_json,
    kind_name,
    remove_em_tags,
    unescape_html,
)


async def get_categories() -> dict[str, Any]:
    """上游 GetPlaylistCategories：显式不支持。"""
    raise RuntimeError("playlist categories not supported")


async def get_category_playlists(_category_id: str, _page: int = 1, _limit: int = 30) -> dict[str, Any]:
    """上游 GetCategoryPlaylists：显式不支持。"""
    raise RuntimeError("playlist categories not supported")


def _map_playlist_song(song_id: str, kind: str, name: str, artist: str) -> dict[str, Any]:
    """歌单列表项（HTML 解析出的歌曲）→ 统一 Song 形状。"""
    return {
        "songmid": f"{song_id}|{kind}",
        "name": name,
        "singer": artist,
        "albumId": "",
        "albumName": "",
        "interval": 0,
        "img": None,
        "lrc": None,
        "types": [],
        "_types": {},
        "songType": kind,
        "typeName": kind_name(kind),
        "link": build_song_link(kind, song_id),
        "source": "5sing",
    }


def parse_songs_from_html(html_content: str) -> list[dict[str, Any]]:
    """上游 parseSongsFromHTML：从歌单页 HTML 提取歌曲。

    块正则 ``<li class="p_rel">([\\s\\S]*?)</li>``；块内 href 提取 yc/fc/bz 与 id，
    s_soner 提取歌手（上游的拼写错误 soner 保留）。
    """
    blocks = re.findall(r'<li class="p_rel">([\s\S]*?)</li>', str(html_content or ""))
    if not blocks:
        raise RuntimeError("no songs found in playlist html (structure mismatch)")

    # 上游正则要求 href="http://5sing.kugou.com/..."；这里放宽协议（http/https/协议相对）
    song_re = re.compile(r'href="(?:(?:https?:)?//)?5sing\.kugou\.com/(yc|fc|bz)/(\d+)\.html"[^>]*>([^<]+)</a>')
    artist_re = re.compile(r'class="s_soner[^"]*".*?>([^<]+)</a>')

    songs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for block in blocks:
        song_match = song_re.search(block)
        if not song_match:
            continue
        kind, song_id, raw_name = song_match.group(1), song_match.group(2), song_match.group(3)

        artist = "Unknown"
        artist_match = artist_re.search(block)
        if artist_match:
            artist = artist_match.group(1)

        unique_key = f"{kind}|{song_id}"
        if unique_key in seen:
            continue
        seen.add(unique_key)

        name = remove_em_tags(unescape_html(raw_name)).strip()
        artist = remove_em_tags(unescape_html(artist)).strip()
        songs.append(_map_playlist_song(song_id, kind, name, artist))
    return songs


async def fetch_creator_name(playlist_id: str) -> str:
    """上游 fetchCreatorName：userName 为空时用 getsonglist?songfields=user 反查创建者名。"""
    if not playlist_id:
        return ""
    try:
        resp = await fetch_5sing_json(
            f"{MOBILE_API}/song/getsonglist?id={encode_uri_component(playlist_id)}&songfields=user"
        )
        if resp.status_code != 200 or not isinstance(resp.body, dict):
            return ""
        data = resp.body.get("data")
        if not isinstance(data, dict):
            return ""
        user = as_dict(data.get("user"))
        return str(user.get("NN") or "")
    except Exception:  # noqa: BLE001 - 反查失败保留 ID 兜底
        return ""


def _map_playlist_summary(item: dict[str, Any]) -> dict[str, Any]:
    """歌单搜索项 → 摘要（与既有平台 playlist 搜索项对齐）。"""
    playlist_id = str(item.get("songListId") or "")
    user_id = str(item.get("userId") or "")
    desc = remove_em_tags(unescape_html(item.get("content")))
    creator = str(item.get("userName") or "") or (f"ID: {user_id}" if user_id else "")
    return {
        "id": playlist_id,
        "name": remove_em_tags(unescape_html(item.get("title"))),
        "cover": str(item.get("pictureUrl") or ""),
        "trackCount": int(item.get("songCnt") or 0),
        "playCount": int(item.get("playCount") or 0),
        "creator": creator,
        "creatorId": user_id,
        # 上游怪癖：content 为字符串 "0" 时视为空简介
        "description": "" if desc == "0" else desc,
        "link": build_playlist_link(user_id, playlist_id),
        "source": "5sing",
    }


async def search_playlist(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """上游 SearchPlaylist（type=1），补创建者名（并发 5）。"""
    word = str(keyword or "").strip()
    page_no = max(1, int(page or 1))
    page_size = max(1, int(limit or 20))
    empty = {"list": [], "total": 0, "page": page_no, "limit": page_size, "source": "5sing"}
    if not word:
        return empty

    url = f"{SEARCH_API}?keyword={encode_uri_component(word)}&sort=1&page={page_no}&filter=0&type=1"
    resp = await fetch_5sing_json(url)
    if resp.status_code != 200:
        raise RuntimeError(f"5sing 歌单搜索失败（HTTP {resp.status_code}）")

    body = as_dict(resp.body)
    raw_list = as_list(body.get("list"))
    playlists = [_map_playlist_summary(item) for item in raw_list[:page_size] if isinstance(item, dict)]

    # 上游并行回退：item.userName 为空时反查真实创建者名（失败保留 "ID: xxx"）
    targets = [pl for pl in playlists if pl["creatorId"] and pl["creator"] == f"ID: {pl['creatorId']}"]
    for start in range(0, len(targets), 5):
        chunk = targets[start : start + 5]

        async def fill(pl: dict[str, Any]) -> None:
            name = await fetch_creator_name(pl["id"])
            if name:
                pl["creator"] = name

        await asyncio.gather(*(fill(pl) for pl in chunk))

    page_info = as_dict(body.get("pageInfo"))
    total = int(page_info.get("totalCount") or 0) or len(playlists)
    return {"list": playlists, "total": total, "page": page_no, "limit": page_size, "source": "5sing"}


async def fetch_playlist_all(playlist_id_raw: str) -> dict[str, Any]:
    """元数据 + 全量曲目（上游 fetchPlaylistDetail 核心；HTML 不分页，一次拿全）。"""
    playlist_id = str(playlist_id_raw or "").strip()
    if not playlist_id:
        raise RuntimeError("invalid 5sing playlist id")

    # 1) API 元数据（标题/封面/统计/UserID）
    resp = await fetch_5sing_json(
        f"{MOBILE_API}/song/getsonglist?id={encode_uri_component(playlist_id)}&songfields=ID,user"
    )
    if resp.status_code != 200:
        raise RuntimeError(f"fetch info failed: HTTP {resp.status_code}")

    # 上游用 RawMessage 判多态：歌单不存在/无权限时 data 为 []（数组），直接报错
    body = as_dict(resp.body)
    data = body.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("playlist info not found or invalid (api returned empty list)")

    user = as_dict(data.get("user"))
    user_id = str(user.get("ID") or "")
    if not user_id:
        raise RuntimeError("playlist user not found or invalid id")

    playlist = {
        "id": playlist_id,
        "name": str(data.get("T") or ""),
        "cover": str(data.get("P") or ""),
        "trackCount": int(data.get("E") or 0),
        "playCount": int(data.get("H") or 0),
        "creator": str(user.get("NN") or ""),
        "description": str(data.get("C") or ""),
        "link": build_playlist_link(user_id, playlist_id),
        "userId": user_id,
        "source": "5sing",
    }

    # 2) 歌单页 HTML（数字 userId 会 302 → 个性域名页，fetch_5sing 已跟跳）
    page = await fetch_5sing(playlist["link"])
    if page.status_code != 200:
        raise RuntimeError(f"fetch html failed: HTTP {page.status_code}")

    # 3) 解析曲目（上游：解析失败不影响元数据返回，返回空列表）
    songs: list[dict[str, Any]] = []
    try:
        songs = parse_songs_from_html(str(page.body if isinstance(page.body, str) else ""))
    except Exception:  # noqa: BLE001 - 结构不匹配时返回空列表
        songs = []
    return {"playlist": playlist, "songs": songs}


def _playlist_info(playlist: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": playlist["id"],
        "name": playlist["name"],
        "img": playlist["cover"],
        "desc": playlist["description"],
        "author": playlist["creator"],
        "link": playlist["link"],
        "trackCount": playlist["trackCount"],
        "playCount": playlist["playCount"],
    }


async def get_playlist_detail(playlist_id: str, page: int = 1, limit: int = 50) -> dict[str, Any]:
    """歌单详情（分页切片；total 为解析到的有效曲目数，trackCount 保留上游元数据 E）。"""
    detail = await fetch_playlist_all(playlist_id)
    playlist, songs = detail["playlist"], detail["songs"]
    page_no = max(1, int(page or 1))
    page_size = max(1, int(limit or 50))
    start = (page_no - 1) * page_size
    total = len(songs)
    return {
        "source": "5sing",
        "info": _playlist_info(playlist),
        "list": songs[start : start + page_size],
        "page": page_no,
        "limit": page_size,
        "total": total,
        "allPage": math.ceil(total / page_size) or 1,
    }


async def get_playlist_songs(playlist_id: str) -> list[dict[str, Any]]:
    """上游 GetPlaylistSongs：仅返回曲目列表（全量）。"""
    detail = await fetch_playlist_all(playlist_id)
    return detail["songs"]


async def parse_playlist_link(link: str) -> dict[str, Any]:
    """上游 ParsePlaylist：歌单链接 → 详情（全量曲目）。"""
    parsed = extract_playlist_link(link)
    if not parsed:
        raise RuntimeError("invalid 5sing playlist link")
    detail = await fetch_playlist_all(parsed["playlistId"])
    playlist, songs = detail["playlist"], detail["songs"]
    return {
        "source": "5sing",
        "info": _playlist_info(playlist),
        "list": songs,
        "page": 1,
        "limit": len(songs) or 1,
        "total": len(songs),
        "allPage": 1,
    }
