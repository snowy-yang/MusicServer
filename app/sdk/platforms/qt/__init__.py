"""蜻蜓FM 平台模块（对应 sdk/qt/index.ts）。

匿名可用面（2026-10-02 实测）：搜索（官网 SSR 解析）/ 频道节目列表（SSR）/
免费节目点播直链（audiostream 签名 302 到华为云 CDN）。

搜索结果为频道（专辑）级条目，songmid=channelId；节目条目 songmid="<channelId>:<programId>"。
付费节目与直播电台签名（Lwrpu$K5oP）暂未接登录。有声内容不参与聚合（noAggregate）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms._base import Platform
from app.sdk.platforms.qt import album, music_search


async def _get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    from app.sdk.apis.qt import get_music_url

    return await get_music_url(song_info, quality, retry_num)


async def get_pic(song_info: dict[str, Any]) -> str | None:
    """搜索结果已带封面；频道详情页无独立封面接口，降级用 SSR 页 og:image。"""
    channel_id = str(song_info.get("songmid") or "").split(":")[0]
    return await album.get_channel_og_image(channel_id)


async def get_album_detail(channel_id: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    del page, limit  # SSR 页一次吐出全部节目，与上游一致不分页
    result = await album.get_channel_programs(channel_id)
    songs = result["list"]
    return {
        "info": {"name": result["name"], "total": len(songs)},
        "list": songs,
        "total": len(songs),
        "limit": len(songs),
        "allPage": 1,
        "source": "qt",
    }


class _QtAlbum:
    get_album_detail = staticmethod(get_album_detail)


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    parts = str(song_info.get("songmid") or "").split(":")
    channel_id = parts[0] if parts else ""
    program_id = parts[1] if len(parts) > 1 else ""
    if program_id:
        return f"https://www.qingting.fm/channels/{channel_id}/programs/{program_id}"
    return f"https://www.qingting.fm/channels/{channel_id}"


MODULE = Platform(
    id="qt",
    name="蜻蜓FM",
    music_search=music_search,
    album=_QtAlbum,
    get_music_url=_get_music_url,
    get_pic=get_pic,
    get_music_detail_page_url=get_music_detail_page_url,
)
