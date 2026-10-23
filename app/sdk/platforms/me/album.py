"""猫耳FM 广播剧集列表（对应 sdk/me/album.ts，web 通道，匿名免签）。

接口: https://www.missevan.com/dramaapi/getdramaepisodes?drama_id=&season=&page=&order=0&pageSize=
结果在 info.episodes.episode[]（name/sound_id/pay_type/vip）；剧名在 info.drama.name。
注意：getdrama（不带 type=2 时）的 info.episodes.episode 同样可用（MusicFree 插件用法），
本接口支持翻页故用之。
"""

from __future__ import annotations

import math
import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict, as_list, format_play_time

EPISODES_URL = "https://www.missevan.com/dramaapi/getdramaepisodes"


async def get_album_detail(drama_id_raw: str, page: int = 1, limit: int = 30) -> dict[str, Any]:
    # 搜索结果的剧条目带 d: 前缀（songmid="d:<id>"），这里剥掉
    drama_id = drama_id_raw[2:] if str(drama_id_raw).startswith("d:") else str(drama_id_raw)
    if not re.fullmatch(r"\d+", drama_id):
        raise RuntimeError("剧 id 无效")
    resp = await http_fetch(
        f"{EPISODES_URL}?drama_id={drama_id}&season=1&page={page}&order=0&pageSize={max(30, limit)}",
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            ),
            "Referer": f"https://www.missevan.com/mdrama/drama/{drama_id}",
            "Accept": "application/json",
        },
        timeout=15_000,
    )
    body = as_dict(resp.body)
    if resp.status_code != 200 or body.get("success") is False:
        raise RuntimeError(str(body.get("info") or f"获取剧集失败（HTTP {resp.status_code}）"))
    info = as_dict(body.get("info"))
    drama = as_dict(info.get("drama"))
    episodes = as_list(as_dict(info.get("episodes")).get("episode"))
    songs = []
    for item in episodes[:limit]:
        if not isinstance(item, dict):
            continue
        duration = item.get("duration")
        songs.append(
            {
                "songmid": str(item.get("sound_id")),
                "name": item.get("name") or "",
                "singer": drama.get("name") or "",
                "albumId": str(drama_id),
                "albumName": drama.get("name") or "",
                "interval": format_play_time(math.floor(float(duration) / 1000 + 0.5)) if duration else 0,
                "payPlay": int(item.get("pay_type") or 0) > 0,
                "img": drama.get("cover") or None,
                "lrc": "",
                "lrcx": "",
                "types": [],
                "_types": {},
                "disabled": False,
            }
        )
    return {
        "info": {"name": drama.get("name") or str(drama_id), "total": len(episodes)},
        "list": songs,
        "total": len(episodes),
        "limit": limit,
        "allPage": 1,
        "source": "me",
    }
