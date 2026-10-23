"""咪咕音乐（对应 sdk/mg/index.ts 的 default export）。

能力位与 TS 一致：搜索 / 专辑 / 歌单 / 链接解析，顶层挂 get_music_url（取流在 apis/mg.py）、
get_lyric、get_pic、get_music_info、get_music_detail_page_url。

TS 侧没有榜单、歌单广场、热搜、歌手、评论、个人歌单子模块，这里一律省略 ——
缺省即不支持，/sources 与路由据此返回 404。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms._base import Platform
from app.sdk.platforms.mg import album, lyric, music_search, parse, playlist
from app.sdk.platforms.mg.lyric import content_id_of
from app.sdk.platforms.mg.util import (
    fetch_song_detail,
    first_non_empty,
    migu_song_link,
    normalize_migu_image_url,
    pick_migu_image,
)


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """取流入口。延迟导入 apis.mg：apis 模块反向依赖 platforms.mg.util，
    模块级互相 import 会在「先导入 apis」的入口下拿到半初始化的模块。"""
    from app.sdk.apis import mg as mg_api

    return await mg_api.get_music_url(song_info, quality, retry_num)


async def get_pic(song_info: dict[str, Any]) -> str | None:
    if song_info.get("img"):
        return str(song_info["img"])
    content_id = content_id_of(song_info)
    if not content_id:
        return None
    item = await fetch_song_detail(content_id)
    return (
        normalize_migu_image_url(
            first_non_empty(
                pick_migu_image(item.get("imgItems")),
                pick_migu_image(item.get("albumImgs")),
                item.get("img1"),
                item.get("img2"),
                item.get("img3"),
            )
        )
        or None
    )


async def get_music_info(song_info: dict[str, Any]) -> dict[str, Any]:
    content_id = content_id_of(song_info)
    if not content_id:
        raise RuntimeError("migu 歌曲 id 无效")
    return await fetch_song_detail(content_id)


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    extra = song_info.get("extra") or {}
    link = str(extra.get("link") or "") if isinstance(extra, dict) else ""
    return link or migu_song_link(content_id_of(song_info))


MODULE = Platform(
    id="mg",
    name="咪咕音乐",
    music_search=music_search,
    album=album,
    playlist=playlist,
    parse=parse,
    get_music_url=get_music_url,
    get_lyric=lyric.get_lyric,
    get_pic=get_pic,
    get_music_info=get_music_info,
    get_music_detail_page_url=get_music_detail_page_url,
)
