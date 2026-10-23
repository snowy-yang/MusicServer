"""QQ音乐链接解析（移植自 sdk/tx/parse.ts）。

歌曲链接形态：
  * https://y.qq.com/n/ryqq/songDetail/<songmid>
  * https://y.qq.com/n/yqq/song/<songmid>.html
  * https://i.y.qq.com/v8/playsong.html?songid=<数字 id>（先反查 songmid）
  * ...?songmid=<songmid>

元数据走 fcg_play_single_song（顺带拿 file 体积信息）。直链 url/type 是尽力附带：
取流失败只返回元数据，不影响解析结果（与上游一致，VIP/下架曲目即如此）。
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import format_play_time, format_singer_name, size_formate
from app.sdk.platforms.tx.filter import album_img

_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 "
    "(KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1"
)

_SONG_DETAIL_RE = re.compile(r"songDetail/([A-Za-z0-9]+)")
_SONG_PATH_RE = re.compile(r"/song/([A-Za-z0-9]+)")
_SONG_MID_QUERY_RE = re.compile(r"[?&]songmid=([A-Za-z0-9]+)")
_SONG_ID_QUERY_RE = re.compile(r"[?&]songid=(\d+)")

_DETAIL_URL = "https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg"


async def _fetch_single_song(query: str) -> dict[str, Any] | None:
    """fcg_play_single_song 首条（query 形如 songmid=xxx / songid=123）。"""
    resp = await http_fetch(
        f"{_DETAIL_URL}?{query}&format=json",
        headers={"User-Agent": _UA, "Referer": "http://m.y.qq.com"},
        timeout=15000,
    )
    if resp.status_code != 200:
        return None
    body = resp.body if isinstance(resp.body, dict) else {}
    data = body.get("data")
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
        return None
    return data[0]


async def fetch_mid_by_song_id(songid: str) -> str:
    """上游 fetchSongDetailByID：数字 songid → mid。"""
    item = await _fetch_single_song(f"songid={quote(str(songid), safe='')}")
    mid = str((item or {}).get("mid") or "")
    if not mid:
        raise RuntimeError("QQ音乐歌曲不存在")
    return mid


async def fetch_song_detail_raw(songmid: str) -> dict[str, Any]:
    """上游 fetchSongDetail：songmid → 原始条目。"""
    item = await _fetch_single_song(f"songmid={quote(str(songmid), safe='')}")
    if not item or not item.get("mid"):
        raise RuntimeError("QQ音乐歌曲不存在")
    return item


def convert_song(item: dict[str, Any]) -> dict[str, Any]:
    """原始条目 → MusicServer Song 形状。

    注意体积字段的判定与 filter.build_types 不同：这里要求 `isinstance(number)` 且 > 0
    （原文是 `typeof size === 'number' && size > 0`），因此字符串型体积会被跳过。
    """
    file = item.get("file") or {}
    types: list[dict[str, Any]] = []
    _types: dict[str, dict[str, Any]] = {}
    for key, quality in (
        ("size_128mp3", "128k"),
        ("size_320mp3", "320k"),
        ("size_flac", "flac"),
        ("size_hires", "flac24bit"),
    ):
        size = file.get(key)
        if isinstance(size, (int, float)) and not isinstance(size, bool) and size > 0:
            formatted = size_formate(size)
            types.append({"type": quality, "size": formatted})
            _types[quality] = {"size": formatted}

    album = item.get("album") or {}
    album_mid = album.get("mid") or ""
    return {
        "source": "tx",
        "songmid": str(item.get("mid")),
        "songId": item.get("id"),
        "name": item.get("title") or item.get("name") or "",
        "singer": format_singer_name(item.get("singer"), "name"),
        "albumId": album_mid,
        "albumMid": album_mid,
        "albumName": album.get("name") or "",
        "interval": format_play_time(item.get("interval") or 0),
        "img": album_img(album_mid) if album_mid else "",
        "lrc": None,
        "strMediaMid": file.get("media_mid") or item.get("mid"),
        "types": types,
        "_types": _types,
        "typeUrl": {},
    }


async def parse_song(link: str) -> dict[str, Any]:
    """歌曲链接 → Song（尽力附带直链 url/type）。"""
    raw = str(link or "")
    match = _SONG_DETAIL_RE.search(raw) or _SONG_PATH_RE.search(raw)
    songmid = match.group(1) if match else ""
    songid = ""
    if not songmid:
        id_match = _SONG_ID_QUERY_RE.search(raw)
        songid = id_match.group(1) if id_match else ""
        mid_match = _SONG_MID_QUERY_RE.search(raw)
        songmid = mid_match.group(1) if mid_match else ""
        if not songmid and songid:
            songmid = await fetch_mid_by_song_id(songid)
    if not songmid:
        raise RuntimeError("无效的QQ音乐歌曲链接")

    item = await fetch_song_detail_raw(songmid)
    song = convert_song(item)
    if songid:
        song["songId"] = int(songid)
    try:
        # 延迟导入：apis.tx 反向依赖 platforms.tx.utils，模块级互 import 会拿到半初始化模块
        from app.sdk.apis import tx as tx_api

        hit = await tx_api.get_music_url(song, "320k")
        song["url"] = hit.get("url")
        song["type"] = hit.get("type")
    except (RuntimeError, OSError, TimeoutError):
        # 与上游一致：直链获取失败忽略（VIP/下架曲目仍返回元数据）
        pass
    return song


async def parse_album(link: str) -> dict[str, Any]:
    from app.sdk.platforms.tx.album import parse_album_link

    return await parse_album_link(link)


async def parse_playlist(link: str) -> dict[str, Any]:
    from app.sdk.platforms.tx.playlist import parse_playlist_link

    return await parse_playlist_link(link)
