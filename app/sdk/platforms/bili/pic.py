"""Bilibili 封面：搜索结果/合集条目已带封面；仅有 id 时回源 x/web-interface/view 取 pic。"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.bili.util import fetch_view, normalize_cover, parse_song_id


async def get_pic(song_info: dict[str, Any]) -> str:
    direct = str(song_info.get("img") or "")
    if direct.startswith(("http://", "https://")):
        return direct
    bvid = str(song_info.get("bvid") or "") or parse_song_id(song_info.get("songmid"))["bvid"]
    if not bvid:
        return ""
    try:
        view = await fetch_view(bvid)
        return normalize_cover(view.get("pic") or "")
    except Exception:  # noqa: BLE001 - 与原文一致：封面取不到返回空串，不影响调用方
        return ""
