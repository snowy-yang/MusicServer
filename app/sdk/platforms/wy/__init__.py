"""网易音乐（wy）平台模块 —— 移植自 sdk/wy/index.ts + sdk/apis/wy.ts。

能力位与原实现对齐：
  music_search / leaderboard / song_list / hot_search / comment / singer /
  album / playlist / parse / user_playlist / get_music_url / get_lyric / get_pic /
  get_music_info / get_music_detail_page_url
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms._base import Platform
from app.sdk.platforms.wy import (
    album,
    comment,
    hot_search,
    leaderboard,
    lyric,
    music_search,
    parse,
    playlist,
    singer,
    song_list,
    user_playlist,
)
from app.sdk.platforms.wy.music_info import get_music_info
from app.sdk.platforms.wy.pic import get_pic


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    return f"https://music.163.com/#/song?id={song_info.get('songmid')}"


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """取流入口。延迟导入 apis.wy：apis 模块反向依赖 platforms.wy.utils，
    模块级互相 import 会在「先导入 apis」的入口下拿到半初始化的模块。"""
    from app.sdk.apis import wy as wy_api

    return await wy_api.get_music_url(song_info, quality, retry_num)


MODULE = Platform(
    id="wy",
    name="网易音乐",
    music_search=music_search,
    leaderboard=leaderboard,
    song_list=song_list,
    hot_search=hot_search,
    comment=comment,
    singer=singer,
    album=album,
    playlist=playlist,
    parse=parse,
    user_playlist=user_playlist,
    get_music_url=get_music_url,
    get_lyric=lyric.get_lyric,
    get_pic=get_pic,
    get_music_info=get_music_info,
    get_music_detail_page_url=get_music_detail_page_url,
)
