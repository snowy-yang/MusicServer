"""网易云歌曲信息（移植自 sdk/wy/musicInfo.ts，走 weapi/v3/song/detail 取原始 song 对象）。

与 music_detail.py 的差别：这里返回上游原始 `songs[0]`（含 al/ar/hr/sq 等），供封面等场景直接取值。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.wy.utils import UA_LINUX_CHROME, weapi_headers
from app.sdk.platforms.wy.utils.crypto import weapi


async def get_music_info(song_info: dict[str, Any]) -> dict[str, Any]:
    """取原始 song 对象。失败文案与原文一致：获取歌曲信息失败。"""
    song_mid = song_info.get("songmid")
    resp = await http_fetch(
        "https://music.163.com/weapi/v3/song/detail",
        method="post",
        headers={
            **weapi_headers(f"https://music.163.com/song?id={song_mid}", with_cookie=False),
            "User-Agent": UA_LINUX_CHROME,
        },
        form=weapi({"c": f'[{{"id":{song_mid}}}]', "ids": f"[{song_mid}]"}),
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    songs = body.get("songs") or []
    if body.get("code") != 200 or not songs:
        raise RuntimeError("获取歌曲信息失败")
    song = songs[0]
    if not isinstance(song, dict):
        raise RuntimeError("获取歌曲信息失败")
    return song
