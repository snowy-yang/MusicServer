"""猫耳FM（MissEvan，ACG 广播剧/音声平台）平台模块（对应 sdk/me/index.ts）。

匿名可用面（2026-10-02 实测）：搜索 / 剧集列表 / 免费声音明文直链 / 封面。
取流走 App API 签名通道（app.missevan.com，HMAC-SHA256(appsecret)），
返回 maoercdn 免签名直链——网页版 hls.m3u8 是 Widevine 加密流，勿用 web soundurl。
付费声音需 POST /login/me 绑定含 token 的 cookie。
有声内容不参与聚合搜索与跨平台匹配（noAggregate），仅按 source=me 直查。
"""

from __future__ import annotations

from typing import Any

from app.sdk.auth_store import get_credentials
from app.sdk.platforms._base import Platform
from app.sdk.platforms.me import album, music_search
from app.sdk.platforms.me.music_info import get_sound_info


async def _get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    from app.sdk.apis.me import get_music_url

    return await get_music_url(song_info, quality, retry_num)


async def get_pic(song_info: dict[str, Any]) -> str | None:
    info = await get_sound_info(str(song_info.get("songmid") or ""))
    return info.get("front_cover") or None


class _MeAlbum:
    get_album_detail = staticmethod(album.get_album_detail)


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    return f"https://www.missevan.com/sound/{song_info.get('songmid') or ''}"


def status() -> dict[str, Any]:
    """登录状态（凭据存在性判断）。"""
    cred = get_credentials("me") or {}
    if cred.get("cookie"):
        return {"logged": True, "updatedAt": cred.get("updatedAt")}
    return {"logged": False}


MODULE = Platform(
    id="me",
    name="猫耳FM",
    music_search=music_search,
    album=_MeAlbum,
    get_music_url=_get_music_url,
    get_pic=get_pic,
    get_music_detail_page_url=get_music_detail_page_url,
)
