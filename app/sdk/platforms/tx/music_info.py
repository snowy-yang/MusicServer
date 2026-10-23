"""QQ音乐歌曲信息（移植自 sdk/tx/musicInfo.ts）。

走 musicu.fcg 的 music.pf_song_detail_svr/get_song_detail_yqq：songmid → track_info。
歌词与评论模块靠它把 songmid 换成数字 songID（接口只认数字 id）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import format_play_time, size_formate
from app.sdk.platforms.tx.utils import MUSICU_URL, UA_MUSICU


def _build_types(file: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """file.size_* → types/_types（0 表示该档不存在，与原文一致）。"""
    types: list[dict[str, Any]] = []
    _types: dict[str, dict[str, Any]] = {}
    for key, quality in (
        ("size_128mp3", "128k"),
        ("size_320mp3", "320k"),
        ("size_flac", "flac"),
        ("size_hires", "flac24bit"),
    ):
        if file.get(key):
            size = size_formate(file[key])
            types.append({"type": quality, "size": size})
            _types[quality] = {"size": size}
    return types, _types


def _song_img(album_id: Any, singers: Any) -> str:
    if album_id in ("", "空", None):
        if isinstance(singers, list) and singers and singers[0].get("mid"):
            return f"https://y.gtimg.cn/music/photo_new/T001R500x500M000{singers[0]['mid']}.jpg"
        return ""
    return f"https://y.gtimg.cn/music/photo_new/T002R500x500M000{album_id}.jpg"


async def get_music_info_by_mid(songmid: str) -> dict[str, Any] | None:
    """songmid → SongInfo；无 media_mid 时返回 None（原文同样返回 null）。"""
    resp = await http_fetch(
        MUSICU_URL,
        method="post",
        headers={"User-Agent": UA_MUSICU},
        body={
            "comm": {"ct": "19", "cv": "1859", "uin": "0"},
            "req": {
                "module": "music.pf_song_detail_svr",
                "method": "get_song_detail_yqq",
                "param": {"song_type": 0, "song_mid": songmid},
            },
        },
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    req = body.get("req") or {}
    if body.get("code") != 0 or req.get("code") != 0:
        raise RuntimeError("获取歌曲信息失败")
    item = (req.get("data") or {}).get("track_info") or {}
    file = item.get("file") or {}
    if not file.get("media_mid"):
        return None

    types, _types = _build_types(file)
    album = item.get("album") or {}
    album_name = album.get("name") or ""
    album_id = album.get("mid") or ""
    singers = item.get("singer") or []

    return {
        "singer": "、".join(str(singer.get("name")) for singer in singers if isinstance(singer, dict)),
        "name": item.get("title"),
        "albumName": album_name,
        "albumId": album_id,
        "source": "tx",
        "interval": format_play_time(item.get("interval")),
        "songId": item.get("id"),
        "albumMid": album.get("mid") or "",
        "strMediaMid": file.get("media_mid"),
        "songmid": item.get("mid"),
        "img": _song_img(album_id, singers),
        "types": types,
        "_types": _types,
        "typeUrl": {},
    }


async def get_music_info(song_info: dict[str, Any]) -> dict[str, Any] | None:
    """Platform.get_music_info 契约：song_info 里取 songmid。"""
    songmid = song_info.get("songmid") or song_info.get("hash") or ""
    if not songmid:
        return None
    return await get_music_info_by_mid(str(songmid))


async def handle_music_info(song_info: dict[str, Any]) -> dict[str, Any]:
    """补全缺失的歌名/歌手/封面；取不到时原样返回（不抛错）。"""
    if song_info.get("name") and song_info.get("singer"):
        return song_info
    try:
        info = await get_music_info(song_info)
    except (RuntimeError, OSError, TimeoutError):
        return song_info
    if not info:
        return song_info
    merged = {**info, **{k: v for k, v in song_info.items() if v}}
    return merged
