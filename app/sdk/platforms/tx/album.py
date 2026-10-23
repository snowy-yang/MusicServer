"""QQ音乐专辑（移植自 sdk/tx/album.ts）。

三条路径：
  * 详情 —— music.musichallAlbum.AlbumSongList/GetAlbumSongList（参数名必须是驼峰
    `albumMid`，下划线形态会被上游以 104400 拒绝）
  * 全量曲目 —— 同一接口按 100 一批翻页（上游 fetchAlbumDetail 的曲目段）
  * 搜索 —— c.y.qq.com 的 search_for_qq_cp `t=8`

GetAlbumInfo 详情接口已停用：专辑名取自曲目自带的 album 信息，作者由曲目歌手去重合成，
封面走平台固定图片 URL 规则。
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

from app.sdk.common.request import http_fetch
from app.sdk.platforms.tx.filter import album_img, music_info_item
from app.sdk.platforms.tx.utils import create_musicu_fetch

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
ALBUM_BATCH = 100

SEARCH_URL = "http://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&p={page}&n={limit}&w={query}&t=8"

_ALBUM_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"albumDetail/([A-Za-z0-9]+)"),
    re.compile(r"/album/([A-Za-z0-9]+)"),
    re.compile(r"albummid=([A-Za-z0-9]+)"),
)


def filter_song_list(raw: Any) -> list[dict[str, Any]]:
    """GetAlbumSongList 的 songList（每项包一层 {songInfo}）→ SongInfo 列表。"""
    return [music_info_item((item or {}).get("songInfo")) for item in raw or []]


def album_link(mid: str) -> str:
    return f"https://y.qq.com/n/ryqq/albumDetail/{mid}"


async def fetch_album_songs(album_id: str) -> dict[str, Any]:
    """专辑曲目全量（GetAlbumSongList 100 一批翻页）。

    终止条件与原文一致：本批为空、本批不足一批、或已翻到 totalNum 为止。
    """
    album_mid = str(album_id or "").strip()
    if not album_mid:
        raise RuntimeError("tx 专辑 id 为空")

    songs: list[dict[str, Any]] = []
    total_num = 0
    begin = 0
    while True:
        body = await create_musicu_fetch(
            {
                "req": {
                    "module": "music.musichallAlbum.AlbumSongList",
                    "method": "GetAlbumSongList",
                    "param": {"albumMid": album_mid, "begin": begin, "num": ALBUM_BATCH, "order": 2},
                }
            }
        )
        req = body.get("req") or {}
        if req.get("code") != 0:
            raise RuntimeError("get album song list faild.")
        data = req.get("data") or {}
        batch = data.get("songList") or []
        if not total_num:
            total_num = int(data.get("totalNum") or 0)
        if not batch:
            break
        songs.extend(batch)
        if len(batch) < ALBUM_BATCH:
            break
        if total_num > 0 and begin + len(batch) >= total_num:
            break
        begin += ALBUM_BATCH

    first: dict[str, Any] = {}
    if songs:
        first = (songs[0] or {}).get("songInfo") or {}
    return {
        "raw": songs,
        "songs": filter_song_list(songs),
        "total": total_num or len(songs),
        "albumMid": album_mid,
        "albumName": (first.get("album") or {}).get("name"),
    }


async def get_album_detail(id: str, page: int = 1, limit: int = 100) -> dict[str, Any]:
    """专辑详情 + 曲目（路由优先走这个签名：get_album_detail(id, page, limit)）。"""
    body = await create_musicu_fetch(
        {
            "req": {
                "module": "music.musichallAlbum.AlbumSongList",
                "method": "GetAlbumSongList",
                "param": {"albumMid": id, "begin": (page - 1) * limit, "num": limit},
            }
        }
    )
    req = body.get("req") or {}
    if req.get("code") != 0:
        raise RuntimeError("get album song list faild.")

    data = req.get("data") or {}
    song_list = data.get("songList") or []
    first: dict[str, Any] = {}
    if song_list:
        first = (song_list[0] or {}).get("songInfo") or {}
    authors: list[str] = []
    for item in song_list:
        for singer in ((item or {}).get("songInfo") or {}).get("singer") or []:
            name = (singer or {}).get("name")
            if name and name not in authors:
                authors.append(name)
    return {
        "source": "tx",
        "info": {
            "name": (first.get("album") or {}).get("name"),
            "img": album_img(str(id)),
            "desc": None,
            "author": "、".join(authors) or None,
        },
        "list": filter_song_list(song_list),
        "page": page,
        "limit": limit,
        "total": data.get("totalNum"),
    }


async def get_album_songs(id: str) -> list[dict[str, Any]]:
    return (await fetch_album_songs(id))["songs"]


async def search_album(keyword: str, page: int = 1, limit: int = 10) -> dict[str, Any]:
    """专辑搜索（上游 SearchAlbum：search_for_qq_cp t=8）。"""
    resp = await http_fetch(
        SEARCH_URL.format(page=page, limit=limit, query=quote(str(keyword or ""), safe="")),
        headers={"User-Agent": _UA, "Referer": "https://y.qq.com/portal/search.html"},
        timeout=15000,
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    raw_data = body.get("data")
    album_data: dict[str, Any] = (raw_data.get("album") if isinstance(raw_data, dict) else None) or {}
    if resp.status_code != 200 or not album_data:
        raise RuntimeError("tx 专辑搜索失败")

    rows: list[dict[str, Any]] = []
    for item in album_data.get("list") or []:
        mid = str((item or {}).get("albumMID") or "").strip()
        if not mid:
            continue
        rows.append(
            {
                "id": mid,
                "name": str(item.get("albumName") or "").strip(),
                "cover": f"https://y.gtimg.cn/music/photo_new/T002R300x300M000{mid}.jpg",
                "trackCount": int(item.get("song_count") or item.get("songCount") or 0),
                "creator": str(item.get("singerName") or "").strip(),
                "description": "",
                "link": album_link(mid),
                "type": "album",
                "albumId": str(item.get("albumID") or ""),
                "publishTime": str(item.get("publicTime") or ""),
                "source": "tx",
            }
        )
    total = int(album_data.get("totalnum") or album_data.get("total") or len(rows)) or len(rows)
    return {"list": rows, "page": page, "limit": limit, "total": total, "source": "tx"}


async def parse_album_link(link: str) -> dict[str, Any]:
    """专辑链接解析（上游 ParseAlbum）：命中任一形态即取详情，否则原文案报错。"""
    raw = str(link or "")
    for pattern in _ALBUM_PATTERNS:
        match = pattern.search(raw)
        if match:
            return await get_album_detail(match.group(1))
    raise RuntimeError("无效的QQ音乐专辑链接")
