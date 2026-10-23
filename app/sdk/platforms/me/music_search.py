"""猫耳FM 搜索（对应 sdk/me/musicSearch.ts，双通道聚合，与网页版对齐）。

广播剧（置顶）: https://www.missevan.com/dramaapi/search?s=&page= → info.Datas[]
  ——网页版搜索排前面的正剧来自这里；getsearch 的 type 参数只有 1UP主/2音单/3声音/4声优，没有剧集类型
声音（补足）:   https://www.missevan.com/sound/getsearch?s=&p=&type=3&page_size=&sort=2 → info.Datas[]

剧条目 songmid 用 "d:<drama_id>" 前缀（取流时自动取首个免费集，见 apis/me.py）；声音条目为裸 sound_id。
"""

from __future__ import annotations

import asyncio
import math
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict, as_list, format_play_time
from app.sdk.platforms.fivesing.util import encode_uri_component

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
H = {"User-Agent": UA, "Accept": "application/json", "Referer": "https://www.missevan.com/sound/search"}


async def _search_dramas(keyword: str, page: int, limit: int) -> list[dict[str, Any]]:
    resp = await http_fetch(
        f"https://www.missevan.com/dramaapi/search?s={encode_uri_component(keyword)}&page={page}",
        headers=H,
        timeout=15_000,
    )
    body = as_dict(resp.body)
    if resp.status_code != 200 or body.get("success") is False:
        return []
    datas = as_list(as_dict(body.get("info")).get("Datas"))
    return [
        {
            "songmid": f"d:{item.get('id')}",
            "name": item.get("name") or "",
            "singer": item.get("author") or "",
            "albumId": str(item.get("id")),
            "albumName": item.get("name") or "",
            "interval": 0,
            "payPlay": True,
            "img": item.get("cover") or None,
            "lrc": "",
            "lrcx": "",
            "types": [],
            "_types": {},
            "disabled": False,
        }
        for item in datas[:limit]
        if isinstance(item, dict)
    ]


async def _search_sounds(keyword: str, page: int, limit: int) -> list[dict[str, Any]]:
    resp = await http_fetch(
        f"https://www.missevan.com/sound/getsearch?s={encode_uri_component(keyword)}&p={page}&type=3&page_size={limit}&sort=2",
        headers=H,
        timeout=15_000,
    )
    body = as_dict(resp.body)
    if resp.status_code != 200 or body.get("success") is False:
        return []
    datas = as_list(as_dict(body.get("info")).get("Datas"))
    songs = []
    for item in datas:
        if not isinstance(item, dict):
            continue
        duration = item.get("duration")
        songs.append(
            {
                "songmid": str(item.get("id")),
                "name": item.get("soundstr") or "",
                "singer": item.get("username") or "",
                "albumId": "",
                "albumName": "",
                "interval": format_play_time(math.floor(float(duration) / 1000 + 0.5)) if duration else 0,
                "payPlay": int(item.get("pay_type") or 0) > 0,
                "img": item.get("front_cover") or None,
                "lrc": "",
                "lrcx": "",
                "types": [],
                "_types": {},
                "disabled": False,
            }
        )
    return songs


async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    """剧优先置顶（约六成配额），零散声音补足；剧集翻页直接传 page。"""
    del retry_num  # 契约参数，web 搜索无重试语义

    async def safe(coro: Any) -> list[dict[str, Any]]:
        try:
            return await coro
        except Exception:  # noqa: BLE001 - 单通道失败不拖垮搜索
            return []

    dramas, sounds = await asyncio.gather(
        safe(_search_dramas(keyword, page, max(4, int(limit * 0.6)))),
        safe(_search_sounds(keyword, page, limit)),
    )
    songs = [*dramas, *sounds][:limit]
    return {
        "allPage": page + (1 if len(songs) >= limit else 0),
        "total": len(dramas) + len(sounds),
        "limit": limit,
        "source": "me",
        "list": songs,
    }
