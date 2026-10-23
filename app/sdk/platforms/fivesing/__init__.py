"""5sing（5sing.kugou.com，酷狗旗下原创/翻唱音乐平台）平台模块（对应 sdk/5sing/index.ts）。

上游 music-lib/fivesing 移植（平台 id 统一为 '5sing'，上游 model.Source 为 "fivesing"）。
能力：搜索（原创 yc / 翻唱 fc / 伴奏 bz，统一种类字段 songType）/ 取流（明文直链，档位 sq→hq→lq）/
     歌词（newget.dynamicWords）/ 歌单（搜索、详情、链接解析）/ 单曲链接解析。

不实现：专辑、封面（上游无 GetPic）、分类歌单/个人歌单（上游显式 not supported，保留抛错语义）、
       榜单/热搜/歌手/评论（上游均无）。

取流入口在 ``app/sdk/apis/fivesing.py``；songmid 约定 ``<songId>|<songType>``（如 "932557|yc"）。
登录：上游 New(cookie) 的 cookie 会随请求发送；本移植从 auth_store 的 5sing 记录读取（无则匿名）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms._base import Platform
from app.sdk.platforms.fivesing import lyric, music_search, parse, playlist
from app.sdk.platforms.fivesing.util import build_song_link, extract_song_id, get_status


async def get_lyric(song_info: dict[str, Any]) -> dict[str, str]:
    return await lyric.get_lyric(song_info)


async def _get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """延迟导入取流实现，避免 apis → 本包 util 的初始化顺序耦合。"""
    from app.sdk.apis.fivesing import get_music_url

    return await get_music_url(song_info, quality, retry_num)


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    if song_info.get("link"):
        return str(song_info["link"])
    ids = extract_song_id(song_info.get("songmid") or song_info.get("id"), song_info.get("songType"))
    if not ids["songID"] or not ids["songType"]:
        return "http://5sing.kugou.com/"
    return build_song_link(ids["songType"], ids["songID"])


class _UserPlaylist:
    """上游 GetUserPlaylists 显式返回 not supported，这里保留同样语义。"""

    @staticmethod
    async def get_list(_page: int = 1, _limit: int = 20) -> dict[str, Any]:
        raise RuntimeError("user playlists not supported")


user_playlist = _UserPlaylist()


def status() -> dict[str, Any]:
    return get_status()


MODULE = Platform(
    id="5sing",
    name="5sing",
    music_search=music_search,
    playlist=playlist,
    parse=parse,
    user_playlist=user_playlist,
    get_music_url=_get_music_url,
    get_lyric=get_lyric,
    get_music_detail_page_url=get_music_detail_page_url,
)
