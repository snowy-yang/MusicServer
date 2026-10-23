"""QQ音乐 SongInfo 组装公共片段。

原 TS 把这套「file.size_* → types/_types」与「专辑图/歌手图」逻辑在
musicSearch / songList / leaderboard / singer / parse 里各抄了一份。迁移时合并到一处，
字段与判定顺序保持原样（顺序影响前端音质下拉的排列）。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.sdk.common.utils import format_play_time, format_singer_name, size_formate

# 顺序即原实现的 push 顺序：(file 字段, 对外音质名)
_SIZE_FIELDS: tuple[tuple[str, str], ...] = (
    ("size_128mp3", "128k"),
    ("size_320mp3", "320k"),
    ("size_flac", "flac"),
    ("size_hires", "flac24bit"),
)


def build_types(file: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """file 体积字段 → (types, _types)。0/缺失表示该档不存在（与原文 `!== 0` 一致）。"""
    types: list[dict[str, Any]] = []
    _types: dict[str, dict[str, Any]] = {}
    for key, quality in _SIZE_FIELDS:
        if file.get(key):
            size = size_formate(file[key])
            types.append({"type": quality, "size": size})
            _types[quality] = {"size": size}
    return types, _types


def song_img(album_mid: Any, singers: Any) -> str:
    """有专辑 mid 用专辑图（T002），否则退回首位歌手头像（T001）。"""
    if album_mid in ("", "空", None):
        if isinstance(singers, list) and singers and isinstance(singers[0], dict) and singers[0].get("mid"):
            return f"https://y.gtimg.cn/music/photo_new/T001R500x500M000{singers[0]['mid']}.jpg"
        return ""
    return f"https://y.gtimg.cn/music/photo_new/T002R500x500M000{album_mid}.jpg"


def album_img(album_mid: Any) -> str:
    """专辑封面（singer 专辑列表、专辑搜索用，不退化到歌手图）。"""
    return f"https://y.gtimg.cn/music/photo_new/T002R500x500M000{album_mid}.jpg"


def music_info_item(item: Mapping[str, Any] | None) -> dict[str, Any]:
    """原始曲目条目 → SongInfo（对应 singer.ts 的 filterMusicInfoItem）。

    比 music_search/filter_list 的版本多带 lrc/otherSource 两个空字段 —— 原文
    只在 filterMusicInfoItem 里带，专辑/歌手曲目沿用这个形状，不要合并掉。
    """
    raw: Mapping[str, Any] = item or {}
    file = raw.get("file") or {}
    types, _types = build_types(file)
    album = raw.get("album") or {}
    album_name = album.get("name") or ""
    album_mid = album.get("mid") or ""
    singers = raw.get("singer") or []
    return {
        "source": "tx",
        "singer": format_singer_name(singers, "name"),
        "name": raw.get("title"),
        "albumName": album_name,
        "albumId": album_mid,
        "albumMid": album_mid,
        "interval": format_play_time(raw.get("interval")),
        "songId": raw.get("id"),
        "songmid": raw.get("mid"),
        "strMediaMid": file.get("media_mid"),
        "img": song_img("" if album_name in ("", "空") else album_mid, singers),
        "lrc": None,
        "otherSource": None,
        "types": types,
        "_types": _types,
        "typeUrl": {},
    }
