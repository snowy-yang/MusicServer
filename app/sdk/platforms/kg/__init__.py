"""酷狗音乐（对应 sdk/kg/index.ts 的 default export）。

能力位与 TS 一致：搜索 / 榜单 / 歌单广场 / 热搜 / 评论 / 歌手 / 专辑 / 歌单 / 解析，
顶层挂 get_music_url（取流在 apis/kg.py）、get_lyric、get_pic、get_music_info
（hash 反查歌名/歌手/时长，供取流失败的酷我兜底使用）、get_music_detail_page_url。
"""

from __future__ import annotations

from typing import Any

from app.sdk.apis.kg import get_music_url
from app.sdk.platforms._base import Platform
from app.sdk.platforms.kg import (
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
)


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    hash_value = song_info.get("hash") or song_info.get("songmid")
    album_id = song_info.get("albumId")
    return f"https://www.kugou.com/song/#hash={hash_value}&album_id={album_id}"


async def get_music_info(song_info: dict[str, Any]) -> dict[str, Any] | None:
    """路由兜底调用：传 `{"hash": id, "songmid": id}`，返回含 name/singer/interval 的 dict。"""
    return await music_info.get_music_info_for_song_info(song_info)


MODULE = Platform(
    id="kg",
    name="酷狗音乐",
    music_search=music_search,
    leaderboard=leaderboard,
    song_list=song_list,
    hot_search=hot_search,
    comment=comment,
    singer=singer,
    album=album,
    playlist=playlist,
    parse=parse,
    get_music_url=get_music_url,
    get_lyric=lyric.get_lyric,
    get_pic=pic.get_pic,
    get_music_info=get_music_info,
    get_music_detail_page_url=get_music_detail_page_url,
)
