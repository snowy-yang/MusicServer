"""酷我音乐（对应 sdk/kw/index.ts 的 default export）。

能力位与 TS 一致：搜索 / 榜单 / 歌单广场 / 热搜 / 评论 / 专辑 / 歌单 / 解析，
顶层挂 get_music_url（取流在 apis/kw.py）、get_lyric、get_pic、get_music_info、
handle_music_info、get_music_detail_page_url。

酷我没有歌手主页子模块（TS 侧也没有），`singer` 能力位留空，路由据此返回 404。
"""

from __future__ import annotations

from typing import Any

from app.sdk.apis.kw import get_music_url
from app.sdk.common.request import http_fetch
from app.sdk.platforms._base import Platform
from app.sdk.platforms.kw import (
    album,
    comment,
    hot_search,
    leaderboard,
    lyric,
    music_search,
    parse,
    pic,
    playlist,
    song_list,
)
from app.sdk.platforms.kw.util import format_singer

MUSIC_INFO_API = "http://www.kuwo.cn/api/www/music/musicInfo?mid={songmid}"


async def get_music_info(song_info: dict[str, Any]) -> dict[str, Any]:
    """歌曲详情（歌名/歌手/封面/专辑）。上游 code != 200 时抛出 msg 原文。"""
    songmid = str(song_info.get("songmid") or "")
    resp = await http_fetch(MUSIC_INFO_API.format(songmid=songmid))
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") == 200:
        return body.get("data") or {}
    raise RuntimeError(str(body.get("msg") or "获取歌曲信息失败"))


async def handle_music_info(song_info: dict[str, Any]) -> dict[str, Any]:
    """用 get_music_info 就地补全 name / singer / img / albumName，与原实现一致。"""
    info = await get_music_info(song_info)
    song_info["name"] = info.get("name")
    song_info["singer"] = format_singer(str(info.get("artist") or ""))
    song_info["img"] = info.get("pic")
    song_info["albumName"] = info.get("album")
    return song_info


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    return f"http://www.kuwo.cn/play_detail/{song_info.get('songmid') or ''}"


async def get_music_urls(music_info: dict[str, Any]) -> dict[str, str]:
    """批量取各档直链，返回 `{type: url}`（原 getMusicUrls 的回调语义）。"""
    import asyncio

    types = music_info.get("types") or []
    songmid = str(music_info.get("songmid") or "")
    results = await asyncio.gather(
        *(get_music_url({"songmid": songmid}, str(item.get("type") or "")) for item in types),
        return_exceptions=True,
    )
    type_url: dict[str, str] = {}
    for res in results:
        if isinstance(res, BaseException):
            continue
        if res.get("url"):
            type_url[str(res.get("type"))] = str(res["url"])
    return type_url


MODULE = Platform(
    id="kw",
    name="酷我音乐",
    music_search=music_search,
    leaderboard=leaderboard,
    song_list=song_list,
    hot_search=hot_search,
    comment=comment,
    album=album,
    playlist=playlist,
    parse=parse,
    get_music_url=get_music_url,
    get_music_urls=get_music_urls,
    get_lyric=lyric.get_lyric,
    get_pic=pic.get_pic,
    get_music_info=get_music_info,
    handle_music_info=handle_music_info,
    get_music_detail_page_url=get_music_detail_page_url,
)
