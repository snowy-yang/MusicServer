"""酷狗封面（对应 sdk/kg/pic.ts）。

走 `media.store.kugou.com/v1/get_res_privilege`，从返回的 `info.image` 里
把 `{size}` 占位替换为上游给的 `imgsize[0]`。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch

PIC_API = "http://media.store.kugou.com/v1/get_res_privilege"

HEADERS = {
    "KG-RC": "1",
    "KG-THash": "expand_search_manager.cpp:852736169:451",
    "User-Agent": "KuGou2012-9020-ExpandSearchManager",
}


def _album_audio_id(song_info: dict[str, Any]) -> Any:
    """songmid 为 32 位时是旧形态（audioId_x），要取 `_` 前的段（修复历史存储变更）。"""
    songmid = str(song_info.get("songmid") or "")
    if len(songmid) == 32:
        return str(song_info.get("audioId") or "").split("_")[0]
    return song_info.get("songmid")


async def get_pic(song_info: dict[str, Any]) -> str:
    body = {
        "appid": 1001,
        "area_code": "1",
        "behavior": "play",
        "clientver": "9020",
        "need_hash_offset": 1,
        "relate": 1,
        "resource": [
            {
                "album_audio_id": _album_audio_id(song_info),
                "album_id": song_info.get("albumId"),
                "hash": song_info.get("hash"),
                "id": 0,
                "name": f"{song_info.get('singer')} - {song_info.get('name')}.mp3",
                "type": "audio",
            }
        ],
        "token": "",
        "userid": 2626431536,
        "vip": 1,
    }
    resp = await http_fetch(PIC_API, method="POST", headers=HEADERS, body=body)
    payload = resp.body if isinstance(resp.body, dict) else {}
    if payload.get("error_code") != 0:
        raise RuntimeError("图片获取失败")
    data = payload.get("data") or [{}]
    info = (data[0] or {}).get("info") or {}
    image = str(info.get("image") or "")
    img = image.replace("{size}", str(info["imgsize"][0])) if info.get("imgsize") else image
    if not img:
        raise RuntimeError("Pic get failed")
    return img
