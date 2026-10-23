"""千千音乐（music.91q.com）平台模块（对应 sdk/bd/index.ts）。

上游 music-lib/qianqian 的移植。匿名可用面（实测）：

* 搜索（type=1）、专辑搜索 + 详情（type=3、album/info）；
* 歌单详情 + 分类 + 分类歌单；
* 歌词（song/info 返回 txt URL）；
* 免费曲目 128k/320k/flac 明文直链（tracklink 签名通道）。

限制（与上游一致，不造假数据）：

* VIP/版权曲目 tracklink 无 path（需登录态会员 cookie），搜索保留但标记 `payPlay`；
* 歌单关键词搜索（`/v1/search?type=6`）服务端已下线（errno 23001），`search_playlist` 返回空列表；
* 上游 GetUserPlaylists 明确 Unsupported，本移植不提供 `user_playlist`；
* 千千无独立封面接口：搜索结果/专辑/歌单自带 pic，缺失时回退 `song/info`；
* 千千无「榜单」概念：`song_list` 以歌单分类作为标签体系（tagId 为 `/v1/tracklist/category` 的 subCate id）。

凭据：cookie 从 `app/sdk/auth_store.py` 的 `get_credentials('bd')` 读取（可选，仅影响 VIP 等登录态资源）。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.platforms._base import Platform
from app.sdk.platforms.bd import album, lyric, music_info, music_search, parse, playlist
from app.sdk.platforms.bd.util import get_qian_cookie


class _SongList:
    """MusicServer 的 songList 契约：`get_list(sort_id, tag_id, page)` / `get_tags()`。

    千千把歌单分类当标签体系，`tagId` 为 subCate id（纯数字才下发，其它回落到「全部」）。
    """

    @staticmethod
    async def get_list(sort_id: Any, tag_id: Any, page: int = 1) -> dict[str, Any]:
        cate = str(tag_id or sort_id or "").strip()
        return await playlist.get_category_playlists(cate if re.fullmatch(r"\d+", cate) else "", page, 30)

    @staticmethod
    async def get_tags() -> dict[str, Any]:
        return await playlist.get_categories()


song_list = _SongList()


async def get_pic(song_info: dict[str, Any]) -> str | None:
    """千千无独立封面接口：先用曲目自带的 img，缺失时回退 song/info。"""
    img = song_info.get("img")
    if img:
        return str(img)
    try:
        info = await music_info.get_song_info(str(song_info.get("songmid") or ""))
        return info.get("img") or None
    except Exception:  # noqa: BLE001 - 与原文一致：封面取不到就返回 null，不影响调用方
        return None


async def get_music_info(song_info: dict[str, Any]) -> dict[str, Any]:
    return await music_info.get_song_info(str(song_info.get("songmid") or ""))


def get_music_detail_page_url(song_info: dict[str, Any]) -> str:
    tsid = str(song_info.get("songmid") or "").strip()
    return f"https://music.91q.com/song/{tsid}" if tsid else "https://music.91q.com/"


def status() -> dict[str, Any]:
    """凭据存在性（cookie 仅用于 VIP/登录态资源，匿名不影响搜索与免费取流）。"""
    return {"logged": True} if get_qian_cookie() else {"logged": False}


async def _get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """延迟导入取流实现：`apis/bd.py` 反过来依赖本包的 util，顶层导入会形成环。"""
    from app.sdk.apis.bd import get_music_url

    return await get_music_url(song_info, quality, retry_num)


MODULE = Platform(
    id="bd",
    name="千千音乐",
    music_search=music_search,
    song_list=song_list,
    album=album,
    playlist=playlist,
    parse=parse,
    get_music_url=_get_music_url,
    get_lyric=lyric.get_lyric,
    get_pic=get_pic,
    get_music_info=get_music_info,
    get_music_detail_page_url=get_music_detail_page_url,
)
