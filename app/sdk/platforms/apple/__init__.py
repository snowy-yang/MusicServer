"""Apple Music 平台模块（对应 sdk/apple/index.ts，上游 music-lib/apple/apple.go 的 Node/TS 移植）。

能力：搜索 / 歌词（TTML，匿名 developer token 通常拿不到）/ 封面 /
     专辑（搜索+详情+链接解析）/ 歌单（搜索+详情+分类+分类歌单+链接解析）/
     链接解析（song/album/playlist）/ 取流（**仅 preview 试听片段**，见 apis/apple.py）。

凭据：auth_store 的 apple 记录，cookie 形如
``"media-user-token=xxx;storefront=cn;token=xxx"``，也支持 storefront/mediaUserToken/token 直填字段。
未实现（上游也没有）：userPlaylist、榜单、热搜、歌手、评论、扫码登录。
"""

from __future__ import annotations

from typing import Any, ClassVar

from app.sdk.auth_store import get_credentials
from app.sdk.platforms._base import Platform
from app.sdk.platforms.apple import album, lyric, music_search, parse, playlist
from app.sdk.platforms.apple.util import (
    apple_artwork_url,
    apple_song_from_catalog,
    apple_web_url,
    extract_apple_id,
    fetch_apple_song_resource,
    get_apple_config,
    get_apple_token,
)


def _song_id_of(song_info: dict[str, Any]) -> str:
    return extract_apple_id(str(song_info.get("songmid") or song_info.get("id") or ""), "song")


async def _init() -> bool:
    """预热 developer token（失败不阻塞启动，路由调用时会重试）。"""
    try:
        await get_apple_token()
        return True
    except Exception:  # noqa: BLE001 - token 预热失败不影响后续请求的重试
        return False


async def _get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    from app.sdk.apis.apple import get_music_url

    return await get_music_url(song_info, quality, retry_num)


async def get_lyric(song_info: dict[str, Any]) -> dict[str, str]:
    return await lyric.get_lyric(song_info)


async def get_pic(song_info: dict[str, Any]) -> str | None:
    """封面：搜索结果自带 img；缺失时回源歌曲详情（best-effort）。"""
    if song_info.get("img"):
        return str(song_info["img"])
    song_id = _song_id_of(song_info)
    if not song_id:
        return None
    try:
        res = await fetch_apple_song_resource(song_id)
        if not res:
            return None
        return apple_artwork_url(res.get("attributes", {}).get("artwork"), 600) or None
    except Exception:  # noqa: BLE001 - 封面取不到返回 None
        return None


async def get_music_info(song_info: dict[str, Any]) -> dict[str, Any] | None:
    """歌曲详情（best-effort；等价上游 Parse(id)）。"""
    song_id = _song_id_of(song_info)
    if not song_id:
        return None
    res = await fetch_apple_song_resource(song_id, "lyrics,albums")
    return apple_song_from_catalog(res) if res else None


class _AppleAlbum:
    """契约 album 能力位（含 TS index.ts 里挂的 parseAlbumLink）。"""

    get_album_detail = staticmethod(album.get_album_detail)
    get_album_songs = staticmethod(album.get_album_songs)
    search_album = staticmethod(album.search_album)
    parse_album_link = staticmethod(album.parse_album_link)


class _AppleSongList:
    """契约别名 songList：Apple 的歌单分类即 genre curators，供 /song-list/apple 复用。"""

    sort_list: ClassVar[list[dict[str, str]]] = [{"name": "热门", "id": "1526756058"}]

    @staticmethod
    async def get_tags() -> dict[str, Any]:
        return await playlist.get_categories()

    @staticmethod
    async def get_list(sort_id: Any, tag_id: Any, page: int = 1, limit: int = 20) -> dict[str, Any]:
        cate = str(tag_id or sort_id or "").strip()
        return await playlist.get_category_playlists(cate, page, limit)


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    if song_info.get("link"):
        return str(song_info["link"])
    song_id = _song_id_of(song_info)
    if not song_id:
        return "https://music.apple.com/"
    return apple_web_url("song", song_id, get_apple_config()["storefront"])


def status() -> dict[str, Any]:
    """登录状态（media-user-token 存在性判断；无在线校验接口）。"""
    cred = get_credentials("apple") or {}
    cfg = get_apple_config()
    if cfg["mediaUserToken"] or cred.get("cookie"):
        return {"logged": True, "updatedAt": cred.get("updatedAt")}
    return {"logged": False}


MODULE = Platform(
    id="apple",
    name="Apple Music",
    init=_init,
    music_search=music_search,
    album=_AppleAlbum,
    playlist=playlist,
    song_list=_AppleSongList,
    parse=parse,
    get_music_url=_get_music_url,
    get_lyric=get_lyric,
    get_pic=get_pic,
    get_music_info=get_music_info,
    get_music_detail_page_url=get_music_detail_page_url,
)
