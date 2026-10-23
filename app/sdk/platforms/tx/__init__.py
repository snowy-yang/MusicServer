"""QQ音乐（对应 sdk/tx/index.ts 的 default export）。

能力位与 TS 一致：搜索 / 榜单 / 歌单广场 / 热搜 / 评论 / 歌手 / 专辑 / 歌单 / 解析 / 个人歌单，
顶层挂 get_music_url（取流在 apis/tx.py）、get_lyric、get_pic、get_music_info /
handle_music_info（songmid → SongInfo，供酷我兜底与评论/歌词反查数字 songId）、
get_music_detail_page_url。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms._base import Platform
from app.sdk.platforms.tx import (
    album,
    comment,
    hot_search,
    leaderboard,
    lyric,
    music_info,
    music_search,
    parse,
    pic,
    playlist,
    singer,
    song_list,
    user_playlist,
)


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """取流入口。延迟导入 apis.tx：apis 模块反向依赖 platforms.tx.utils，
    模块级互相 import 会在「先导入 apis」的入口下拿到半初始化的模块（wy 已踩过）。"""
    from app.sdk.apis import tx as tx_api

    return await tx_api.get_music_url(song_info, quality, retry_num)


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    return f"https://y.qq.com/n/yqq/song/{song_info.get('songmid')}.html"


MODULE = Platform(
    id="tx",
    name="QQ音乐",
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
    get_pic=pic.get_pic,
    get_music_info=music_info.get_music_info,
    handle_music_info=music_info.handle_music_info,
    get_music_detail_page_url=get_music_detail_page_url,
)
