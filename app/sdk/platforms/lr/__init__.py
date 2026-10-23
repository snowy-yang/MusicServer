"""懒人听书（lrts.me）平台模块（对应 sdk/lr/index.ts）。

匿名可用面（2026-10-02 实测）：搜索（App 通道游客态）/ 章节列表（web 免签）。
取流需登录（web getPlayPath，免费章节也要会话）：POST /login/lr 账号密码登录。
章节 songmid 为复合 id ``<bookId>:<section>``；有声内容不参与聚合（noAggregate）。
"""

from __future__ import annotations

import math
from typing import Any

from app.sdk.platforms._base import Platform
from app.sdk.platforms.lr import menu, music_search


async def _get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    from app.sdk.apis.lr import get_music_url

    return await get_music_url(song_info, quality, retry_num)


async def get_pic(_song_info: dict[str, Any]) -> None:
    """书籍封面无独立免签接口；搜索结果的 img 字段已带封面（这里返回 None 由调用方回退）。"""
    return None


async def get_album_detail(book_id: str, page: int = 1, limit: int = 30) -> dict[str, Any]:
    result = await menu.get_book_menu(book_id, page, limit)
    total = result["total"]
    songs = []
    for item in result["list"][:limit]:
        if not isinstance(item, dict):
            continue
        section = item.get("section")
        songs.append(
            {
                "songmid": f"{book_id}:{section}",
                "name": item.get("name") or f"第{section}节",
                "singer": "",
                "albumId": str(book_id),
                "albumName": "",
                "interval": 0,
                "payPlay": str(item.get("listenPrice")) != "0",
                "img": None,
                "lrc": "",
                "lrcx": "",
                "types": [],
                "_types": {},
                "disabled": False,
            }
        )
    return {
        "info": {"name": f"书籍 {book_id}", "total": total},
        "list": songs,
        "total": total,
        "limit": limit,
        "allPage": math.ceil(total / 30) or page,
        "source": "lr",
    }


class _LrAlbum:
    get_album_detail = staticmethod(get_album_detail)


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    book_id = str(song_info.get("songmid") or "").split(":")[0]
    return f"https://m.lrts.me/book/{book_id}"


MODULE = Platform(
    id="lr",
    name="懒人听书",
    music_search=music_search,
    album=_LrAlbum,
    get_music_url=_get_music_url,
    get_pic=get_pic,
    get_music_detail_page_url=get_music_detail_page_url,
)
