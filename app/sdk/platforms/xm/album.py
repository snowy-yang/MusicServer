"""喜马拉雅专辑曲目列表（对应 sdk/xm/album.ts，免签匿名接口）。

接口: https://www.ximalaya.com/revision/album/getTracksList?albumId=&pageNum=&sort=0
实测（2026-10-02）匿名可翻全部页（固定每页 30 条）；仅曲目元信息（trackId/title/isPaid），
播放地址需另走 baseInfo。注意 v1 版接口（/revision/album/v1/getTracksList）需要 webtk 签名且有风控。
"""

from __future__ import annotations

import math
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict, as_list
from app.sdk.platforms.xm.sign import XM_UA

TRACKS_URL = "https://www.ximalaya.com/revision/album/getTracksList"
PAGE_SIZE = 30


async def get_tracks_page(album_id: str, page_num: int) -> dict[str, Any]:
    """抓取专辑第 page_num 页曲目（返回 {total, tracks}）。"""
    resp = await http_fetch(
        f"{TRACKS_URL}?albumId={album_id}&pageNum={page_num}&sort=0",
        headers={"User-Agent": XM_UA, "Referer": f"https://www.ximalaya.com/album/{album_id}"},
        timeout=15_000,
    )
    body = as_dict(resp.body)
    if resp.status_code != 200 or body.get("ret") != 200 or not body.get("data"):
        raise RuntimeError(str(body.get("msg") or f"获取专辑曲目失败（ret {body.get('ret', resp.status_code)}）"))
    data = as_dict(body.get("data"))
    return {
        "total": int(data.get("trackTotalCount") or 0),
        "tracks": [item for item in as_list(data.get("tracks")) if isinstance(item, dict)],
    }


async def get_album_detail(album_id: str, page: int = 1, limit: int = 30) -> dict[str, Any]:
    """专辑详情 + 指定页曲目（/album 路由适配：{info, list}，接口固定每页 30 条）。"""
    result = await get_tracks_page(album_id, page)
    total = result["total"]
    album_name = ""
    songs: list[dict[str, Any]] = []
    for item in result["tracks"][:limit]:
        if not album_name and item.get("albumTitle"):
            album_name = str(item["albumTitle"])
        songs.append(
            {
                "songmid": str(item.get("trackId")),
                "name": item.get("title") or str(item.get("trackId")),
                "singer": item.get("albumTitle") or "",
                "albumId": str(album_id),
                "albumName": item.get("albumTitle") or "",
                "interval": 0,
                "payPlay": bool(item.get("isPaid")),
                "img": None,
                "lrc": "",
                "lrcx": "",
                "types": [],
                "_types": {},
                "disabled": False,
            }
        )
    return {
        "info": {"name": album_name or str(album_id), "total": total},
        "list": songs,
        "total": total,
        "limit": limit,
        "allPage": math.ceil(total / PAGE_SIZE) or page,
        "source": "xm",
    }
