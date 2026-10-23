"""JOOX（joox）平台模块（对应 sdk/joox/index.ts）。

匿名可用面（2026-10 实测，www 站点需 X-Forwarded-For 东南亚 IP 绕过地区拦截）：
  搜索 / 专辑（搜索+详情+链接解析）/ 歌单（搜索+详情+链接解析）/ 歌词 / 链接解析（歌曲）/
  取流（游客 128k MP3，VIP 曲目为 preview/refrain 片段）。

通道：
  * 搜索/专辑搜索/歌单搜索：cache.api.joox.com/openjoox/v3/search（**无签名**）
  * 取流/歌曲详情/专辑曲目/歌单曲目：cache.api.joox.com/openjoox2/v1（**需 md5 签名**，见 util.joox_sign）
  * 歌词：api.joox.com/web-fcgi-bin/web_lyric（旧接口仍可用；失败回退 openjoox2 lrc_content）
  * 分类/歌单/专辑 SSR 兜底：www.joox.com __NEXT_DATA__

userPlaylist：上游 joox/user_playlist.go 返回 ErrUserPlaylistsUnsupported，未实现（不造）。

⚠ 网络连通性实况（本机出口 IP 非东南亚）：
  * cache.api.joox.com 与 api.joox.com 的 JSON 接口全部可直连；
  * www.joox.com 的 SSR 页面返回「Sorry, JOOX is not available in this location」，无 __NEXT_DATA__，
    因此 ``playlist.get_categories`` / ``playlist.get_category_playlists`` 与专辑·歌单的页面兜底
    在当前网络下会如实抛错（不返回假数据）。这与 TS 注释一致：TS 也依赖伪造 X-Forwarded-For，
    本移植带的是同一个头（``util.JOOX_XFF``），能否生效取决于上游是否采信，实测本机未被采信。
"""

from __future__ import annotations

from typing import Any, ClassVar

from app.sdk.apis.joox import get_music_url
from app.sdk.auth_store import get_credentials
from app.sdk.platforms._base import Platform
from app.sdk.platforms.joox import album, lyric, music_search, parse, playlist
from app.sdk.platforms.joox.music_info import get_track_detail
from app.sdk.platforms.joox.util import joox_song_link, normalize_joox_id, pick_joox_image


class JOOXSongList:
    """契约别名 ``songList``（对应 TS index.ts 里的内联 shim）。

    JOOX 没有独立的「排行榜/歌曲列表」接口：``getTags`` 即歌单分类，``getList`` 即某分类下的歌单。
    ``sort_list`` 只有「全部」一项，因此路由透传的 ``sort_id`` 恒为空串，``tag_id`` 才是分类号。
    TS 的 ``getList(sortId, tagId, page, limit=30)`` 中 ``limit`` 固定在内部，路由不透传。
    """

    sort_list: ClassVar[list[dict[str, str]]] = [{"name": "全部", "id": ""}]

    @staticmethod
    async def get_tags() -> dict[str, Any]:
        return await playlist.get_categories()

    @staticmethod
    async def get_list(sort_id: str = "", tag_id: str = "", page: int = 1) -> dict[str, Any]:
        return await playlist.get_category_playlists(str(tag_id or sort_id or ""), page, 30)


async def _get_pic(song_info: dict[str, Any]) -> str | None:
    """封面（对应 TS index.ts 的 getPic）：走 openjoox2 track 详情后挑图，取不到返回 None。"""
    song_id = normalize_joox_id(song_info.get("songmid") or song_info.get("id") or "")
    detail = await get_track_detail(song_id)
    return pick_joox_image(detail.get("images")) or None


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    return joox_song_link(song_info.get("songmid") or song_info.get("id") or "")


def status() -> dict[str, Any]:
    """登录状态（凭据存在性判断；无在线校验接口）。"""
    cred = get_credentials("joox")
    if cred and cred.get("cookie"):
        return {"logged": True, "updatedAt": cred.get("updatedAt")}
    return {"logged": False}


MODULE = Platform(
    id="joox",
    name="JOOX",
    music_search=music_search,
    song_list=JOOXSongList,
    album=album,
    playlist=playlist,
    parse=parse,
    get_music_url=get_music_url,
    get_lyric=lyric.get_lyric,
    get_pic=_get_pic,
    get_music_detail_page_url=get_music_detail_page_url,
)
