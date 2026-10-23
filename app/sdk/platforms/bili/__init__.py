"""哔哩哔哩（bili）平台模块（对应 sdk/bili/index.ts）。

上游 music-lib/bilibili 的移植，能力位：搜索 / 取流（DASH，VIP 可出 FLAC/Hi-Res）/ 歌单
（合集 ugc_season + 多分P稿件）/ 链接解析（BV/av、分P）/ 封面 / 扫码登录。

不实现（上游即未实现）：专辑、歌词（空实现）、榜单、热搜、歌手、评论、个人歌单。
取流入口在 ``app/sdk/apis/bili.py``，songmid 约定 ``<bvid>|<cid>``。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms._base import Platform
from app.sdk.platforms.bili import lyric, music_search, parse, pic, playlist
from app.sdk.platforms.bili.util import parse_song_id


async def _get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """延迟导入取流实现：apis 模块反向依赖本包的 util，顶层导入不必要地增加耦合。"""
    from app.sdk.apis.bili import get_music_url

    return await get_music_url(song_info, quality, retry_num)


async def get_lyric(song_info: dict[str, Any]) -> dict[str, str]:
    return await lyric.get_lyric(song_info)


async def get_pic(song_info: dict[str, Any]) -> str:
    return await pic.get_pic(song_info)


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    if song_info.get("link"):
        return str(song_info["link"])
    bvid = str(song_info.get("bvid") or "") or parse_song_id(song_info.get("songmid"))["bvid"]
    if not bvid:
        return "https://www.bilibili.com/"
    try:
        page = int(song_info.get("page") or 0)
    except (TypeError, ValueError):
        page = 0
    return f"https://www.bilibili.com/video/{bvid}{f'?p={page}' if page > 1 else ''}"


MODULE = Platform(
    id="bili",
    name="哔哩哔哩",
    music_search=music_search,
    playlist=playlist,
    parse=parse,
    get_music_url=_get_music_url,
    get_lyric=get_lyric,
    get_pic=get_pic,
    get_music_detail_page_url=get_music_detail_page_url,
)
