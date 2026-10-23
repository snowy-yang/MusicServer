"""QQ音乐封面（移植自 sdk/tx/index.ts 的 getPic）。

封面是固定 URL 规则：T002 = 专辑图，按 albumId/albumMid 拼。路由总是传 albumId（缺省空串），
这里对 None 也按空串处理（原 JS 会把 undefined 拼成字面量 "undefined"，无实际意义）。
"""

from __future__ import annotations

from typing import Any


async def get_pic(song_info: dict[str, Any]) -> str:
    album_id = song_info.get("albumId") or ""
    return f"https://y.gtimg.cn/music/photo_new/T002R500x500M000{album_id}.jpg"
