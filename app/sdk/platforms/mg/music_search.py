"""咪咕音乐搜索（对应 sdk/mg/musicSearch.ts）。

search_all.do（Android_migu 参数），searchSwitch 控制返回类别 —— 歌曲/专辑/歌单三个
子模块共用这一个接口，只切换 searchSwitch。
上游对应 music-lib/migu/migu.go 的 (*Migu).Search。
"""

from __future__ import annotations

import json
import math
from typing import Any

from app.sdk.platforms.mg.util import build_url, convert_item_to_song, migu_get, parse_int

SEARCH_ALL_URL = "http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do"


def search_switch(kind: str) -> str:
    """搜索开关：只开某一类（song/album/songlist），bestShow 保留最优推荐。"""
    payload = {
        "song": 1 if kind == "song" else 0,
        "album": 1 if kind == "album" else 0,
        "singer": 0,
        "tagSong": 0,
        "mvSong": 0,
        "songlist": 1 if kind == "songlist" else 0,
        "bestShow": 1,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


async def search_all(text: str, kind: str, page: int = 1, limit: int = 20) -> Any:
    url = build_url(
        SEARCH_ALL_URL,
        {
            "ua": "Android_migu",
            "version": "5.0.1",
            "text": text,
            "pageNo": page,
            "pageSize": limit,
            "searchSwitch": search_switch(kind),
        },
    )
    return await migu_get(url)


async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    body = await search_all(keyword, "song", page, limit)
    data = body.get("songResultData") if isinstance(body, dict) else None
    result = (data or {}).get("result") or []
    songs = [song for item in result if (song := convert_item_to_song(item, True)) is not None]
    total = parse_int((data or {}).get("totalCount")) or len(songs)
    return {
        "list": songs,
        "allPage": max(1, math.ceil(total / limit)),
        "total": total,
        "limit": limit,
        "source": "mg",
    }
