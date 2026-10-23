"""喜马拉雅（有声书/播客）平台模块（对应 sdk/xm/index.ts）。

匿名可用面（2026-10-02 实测）：搜索 / 专辑曲目 / 免费曲目取流（PC baseInfo 通道 + 解密直链）/ 封面。
付费与 VIP 内容：绑定登录 Cookie（POST /login/xm，须含 1&_token）后 baseInfo 授权放行；
超清（XimiUhq）需会员。有声内容不参与聚合搜索与跨平台匹配（sdk 标记 noAggregate），
仅按 source=xm 直查。
"""

from __future__ import annotations

from typing import Any

from app.sdk.auth_store import get_credentials
from app.sdk.platforms._base import Platform
from app.sdk.platforms.xm import album, music_search
from app.sdk.platforms.xm.music_info import cover_url, get_track_info


async def _get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    from app.sdk.apis.xm import get_music_url

    return await get_music_url(song_info, quality, retry_num)


async def get_pic(song_info: dict[str, Any]) -> str | None:
    return cover_url(await get_track_info(str(song_info.get("songmid") or "")))


class _XmAlbum:
    get_album_detail = staticmethod(album.get_album_detail)


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    return f"https://www.ximalaya.com/sound/{song_info.get('songmid') or ''}"


def status() -> dict[str, Any]:
    """登录状态（凭据存在性判断，无在线校验接口）。"""
    cred = get_credentials("xm") or {}
    if cred.get("cookie"):
        return {"logged": True, "updatedAt": cred.get("updatedAt")}
    return {"logged": False}


MODULE = Platform(
    id="xm",
    name="喜马拉雅",
    music_search=music_search,
    album=_XmAlbum,
    get_music_url=_get_music_url,
    get_pic=get_pic,
    get_music_detail_page_url=get_music_detail_page_url,
)
