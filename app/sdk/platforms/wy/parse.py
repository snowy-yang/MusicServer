"""网易云链接解析（移植自 sdk/wy/parse.ts，上游 music-lib/netease/song.go 的 Parse）。

歌曲链接形态：
  https://music.163.com/#/song?id=29732995
  https://music.163.com/song?id=29732995
  https://music.163.com/song/29732995
裸数字 id 也接受（补充便利；上游仅接受链接）。
直链 url/type 为尽力附带，失败不影响元数据返回（与上游一致）；
歌单/专辑链接抛清晰错误，提示改用 parse_playlist / parse_album。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.wy.album import convert_song, parse_album_link
from app.sdk.platforms.wy.link import parse_netease_link
from app.sdk.platforms.wy.playlist import parse_playlist_link
from app.sdk.platforms.wy.utils import UA_LINUX_CHROME, weapi_headers
from app.sdk.platforms.wy.utils.crypto import weapi


async def fetch_song_by_id(song_id: str) -> dict[str, Any]:
    """上游 fetchSongsBatch 的单曲版（weapi/v3/song/detail）。"""
    resp = await http_fetch(
        "https://music.163.com/weapi/v3/song/detail",
        method="post",
        headers={**weapi_headers(), "User-Agent": UA_LINUX_CHROME},
        form=weapi({"c": f'[{{"id":{song_id}}}]', "ids": f"[{song_id}]"}),
        timeout=15000,
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 200:
        raise RuntimeError(f"wy 歌曲详情获取失败 (code {body.get('code', resp.status_code)})")
    songs = body.get("songs") or []
    item = songs[0] if songs else None
    if not isinstance(item, dict) or not item.get("id"):
        raise RuntimeError("netease song not found")
    return convert_song(item)


async def parse_song(link: str) -> dict[str, Any]:
    """歌曲链接 → SongInfo（尽力附带直链 url/type）。"""
    raw = str(link or "").strip()
    if not raw:
        raise RuntimeError("无效的网易云歌曲链接")

    if raw.isdigit():
        song_id = raw
    else:
        try:
            kind, parsed_id = parse_netease_link(raw)
        except ValueError as err:
            raise RuntimeError("无效的网易云歌曲链接") from err
        if kind == "playlist":
            raise RuntimeError("检测到网易云歌单链接，请使用 parsePlaylist")
        if kind == "album":
            raise RuntimeError("检测到网易云专辑链接，请使用 parseAlbum")
        song_id = parsed_id

    song = await fetch_song_by_id(song_id)
    try:
        # 延迟导入：apis.wy 反向依赖 platforms.wy.utils，模块级互相 import 会成环
        from app.sdk.apis import wy as wy_api

        hit = await wy_api.get_music_url(song, "320k")
        song["url"] = hit["url"]
        song["type"] = hit["type"]
    except Exception as err:  # noqa: BLE001 - 与上游一致：直链失败忽略（VIP/下架曲目仍返回元数据）
        print(f"[wy] 解析歌曲时取流失败（已忽略）: {err}")
    return song


async def parse_album(link: str) -> dict[str, Any]:
    return await parse_album_link(link)


async def parse_playlist(link: str) -> dict[str, Any]:
    return await parse_playlist_link(link)
