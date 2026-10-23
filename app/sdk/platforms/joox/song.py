"""JOOX 歌曲形状映射（对应 sdk/joox/song.ts）。

统一 Song 形状（见 tmp/port-spec.md）；兼容来源：openjoox2 track/album/playlist 条目、
openjoox v3 search 的 song_info、以及 SSR 页面上的 track 条目（字段有 snake/camel 两套命名，
上游 Go 也两套都兜底）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.utils import format_play_time
from app.sdk.platforms.joox.util import (
    first_non_empty,
    first_non_zero,
    joox_artists,
    normalize_joox_id,
    pick_joox_image,
    to_int,
)


def joox_song_from_track(
    item: Any,
    fallback_album: str = "",
    fallback_cover: str = "",
    fallback_album_id: str = "",
) -> dict[str, Any] | None:
    """详情/列表 track 条目 → 统一 Song 形状。"""
    if not isinstance(item, dict):
        item = {}
    songmid = normalize_joox_id(item.get("id"))
    if not songmid:
        return None

    artists = item.get("artist_list")
    if not (isinstance(artists, list) and artists):
        artists = item.get("artistList")
    album_id = normalize_joox_id(first_non_empty(item.get("album_id"), item.get("albumId"), fallback_album_id))

    return {
        "songmid": songmid,
        "name": str(first_non_empty(item.get("name"), item.get("title"), "Unknown")),
        "singer": str(first_non_empty(joox_artists(artists), "Unknown")),
        "albumId": str(album_id or ""),
        "albumName": str(first_non_empty(item.get("album_name"), item.get("albumName"), fallback_album)),
        "interval": format_play_time(
            first_non_zero(item.get("play_duration"), item.get("playDuration"), item.get("duration"))
        ),
        "img": str(
            first_non_empty(
                pick_joox_image(item.get("images")),
                item.get("imgSrc"),
                item.get("cover"),
                item.get("image"),
                item.get("pic"),
                fallback_cover,
            )
        )
        or None,
        "lrc": None,
        "vip": to_int(item.get("vip_flag") if item.get("vip_flag") is not None else 0) == 1,
        "types": [],
        "_types": {},
        "source": "joox",
    }


def joox_song_from_search(info: Any) -> dict[str, Any] | None:
    """openjoox v3 搜索歌曲条目（song_info）→ 统一 Song 形状。"""
    return joox_song_from_track(info)


def joox_song_from_detail(detail: Any, play_url: str = "") -> dict[str, Any]:
    """详情接口返回的整曲信息（parse 用，含可播放地址）→ 统一 Song 形状。"""
    if not isinstance(detail, dict):
        detail = {}
    song = joox_song_from_track(detail)
    if song is None:
        song = {
            "songmid": normalize_joox_id(detail.get("id")),
            "name": str(detail.get("name") or ""),
            "singer": str(joox_artists(detail.get("artist_list"))),
            "albumId": str(normalize_joox_id(detail.get("album_id"))),
            "albumName": str(detail.get("album_name") or ""),
            "interval": format_play_time(first_non_zero(detail.get("play_duration"))),
            "img": str(pick_joox_image(detail.get("images"))) or None,
            "lrc": None,
            "types": [],
            "_types": {},
            "source": "joox",
        }
    if play_url:
        song["url"] = play_url
    song["vip"] = to_int(detail.get("vip_flag") if detail.get("vip_flag") is not None else 0) == 1
    return song
