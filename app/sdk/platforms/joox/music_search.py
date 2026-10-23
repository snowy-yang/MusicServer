"""JOOX 搜索（对应 sdk/joox/musicSearch.ts，上游 joox/song.go Search 移植）。

端点：GET https://cache.api.joox.com/openjoox/v3/search?country=sg&lang=zh_cn&keyword=<kw>
返回 ``section_list``（0 歌曲 / 1 专辑 / 2 歌手 / 3 歌单 / 5 最佳结果 / 7 用户），
歌曲在 ``item_list[].song[].song_info``。

该接口**无分页参数**（上游也未分页），``page`` 仅为统一契约保留；``allPage`` 恒为 1，
``total`` 是去重后的本次结果条数（不是上游分页总数）。
实测（2026-10）：中文/英文关键词均 HTTP 200。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.joox.song import joox_song_from_search
from app.sdk.platforms.joox.util import JOOX_TIMEOUT, encode_uri_component, joox_headers

SEARCH_URL = "https://cache.api.joox.com/openjoox/v3/search"


def build_search_url(keyword: str) -> str:
    return f"{SEARCH_URL}?country=sg&lang=zh_cn&keyword={encode_uri_component(keyword or '')}"


async def search(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """搜索歌曲。``page`` 不参与请求（上游无分页），保留以对齐契约。"""
    url = build_search_url(str(keyword or ""))
    res = await http_fetch(url, headers=joox_headers(), timeout=JOOX_TIMEOUT)
    body = res.body
    if res.status_code != 200 or not isinstance(body, dict) or not body.get("section_list"):
        return {"list": [], "allPage": 0, "total": 0, "limit": limit, "source": "joox"}

    songs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for section in body["section_list"]:
        if not isinstance(section, dict):
            continue
        for item in section.get("item_list") or []:
            if not isinstance(item, dict):
                continue
            for entry in item.get("song") or []:
                info = entry.get("song_info") if isinstance(entry, dict) else None
                song = joox_song_from_search(info)
                if not song or song["songmid"] in seen:
                    continue
                seen.add(song["songmid"])
                songs.append(song)

    return {
        "list": songs[:limit],
        "allPage": 1,
        "total": len(songs),
        "limit": limit,
        "source": "joox",
    }
