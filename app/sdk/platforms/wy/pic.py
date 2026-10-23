"""网易云封面（移植自 sdk/wy/index.ts 的 getPic → musicInfo.ts 的 song_detail）。

原文行为：取 song/detail 的 `al.picUrl`，失败即报错（无降级链）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.wy.music_info import get_music_info


async def get_pic(song_info: dict[str, Any]) -> str:
    info = await get_music_info(song_info)
    album = info.get("al") or {}
    url = album.get("picUrl")
    if not url:
        raise RuntimeError("获取封面失败")
    return str(url)
