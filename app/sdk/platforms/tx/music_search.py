"""QQ音乐搜索（移植自 sdk/tx/musicSearch.ts）。

走 musics.fcg 签名通道（zzc 签名 + SearchCgiService/DoSearchForQQMusicMobile）。
item_song → SongInfo；无 media_mid 的条目直接丢弃（原文同样 skip）。
"""

from __future__ import annotations

import random
from typing import Any

from app.sdk.common.utils import format_play_time, format_singer_name
from app.sdk.platforms.tx.filter import build_types, song_img
from app.sdk.platforms.tx.utils import sign_request

DEFAULT_LIMIT = 50
SUCCESS_CODE = 0

# 客户端指纹参数，原样照抄（少一项上游会拒）
_SEARCH_COMM: dict[str, str] = {
    "ct": "11",
    "cv": "14090508",
    "v": "14090508",
    "tmeAppID": "qqmusic",
    "phonetype": "EBG-AN10",
    "deviceScore": "553.47",
    "devicelevel": "50",
    "newdevicelevel": "20",
    "rom": "HuaWei/EMOTION/EmotionUI_14.2.0",
    "os_ver": "12",
    "OpenUDID": "0",
    "OpenUDID2": "0",
    "QIMEI36": "0",
    "udid": "0",
    "chid": "0",
    "aid": "0",
    "oaid": "0",
    "taid": "0",
    "tid": "0",
    "wid": "0",
    "uid": "0",
    "sid": "0",
    "modeSwitch": "6",
    "teenMode": "0",
    "ui_mode": "2",
    "nettype": "1020",
    "v4ip": "",
}


def _search_id() -> str:
    """对应原实现的 `Math.random().toString().slice(2)`：去掉 `0.` 前缀的随机数字串。"""
    return str(random.random()).split(".", 1)[-1]


def handle_result(raw_list: Any) -> list[dict[str, Any]]:
    if not raw_list or not isinstance(raw_list, list):
        return []
    songs: list[dict[str, Any]] = []
    for item in raw_list:
        file = (item or {}).get("file") or {}
        if not file.get("media_mid"):
            continue
        types, _types = build_types(file)
        album = item.get("album") or {}
        album_mid = album.get("mid") or ""
        singers = item.get("singer") or []
        songs.append(
            {
                "singer": format_singer_name(singers, "name"),
                "name": item.get("title"),
                "albumName": album.get("name") or "",
                "albumId": album_mid,
                "source": "tx",
                "interval": format_play_time(item.get("interval")),
                "songId": item.get("id"),
                "albumMid": album_mid,
                "strMediaMid": file.get("media_mid"),
                "songmid": item.get("mid"),
                "img": song_img(album_mid, singers),
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return songs


async def _music_search(keyword: str, page: int, limit: int, retry_num: int) -> dict[str, Any]:
    """签名通道搜索。重试上限 5 次（文案与原文一致：搜索失败）。"""
    if retry_num > 5:
        raise RuntimeError("搜索失败")
    resp = await sign_request(
        {
            "comm": _SEARCH_COMM,
            "req": {
                "module": "music.search.SearchCgiService",
                "method": "DoSearchForQQMusicMobile",
                "param": {
                    "search_type": 0,
                    "searchid": _search_id(),
                    "query": keyword,
                    "page_num": page,
                    "num_per_page": limit,
                    "highlight": 0,
                    "nqc_flag": 0,
                    "multi_zhida": 0,
                    "cat": 2,
                    "grp": 1,
                    "sin": 0,
                    "sem": 0,
                },
            },
        }
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    req = body.get("req") or {}
    if not req or body.get("code") != SUCCESS_CODE or req.get("code") != SUCCESS_CODE:
        return await _music_search(keyword, page, limit, retry_num + 1)
    return req.get("data") or {}


async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    if not limit:
        limit = DEFAULT_LIMIT
    data = await _music_search(keyword, page, limit, retry_num)
    # 响应结构：req.data.{body, meta}。歌曲数组在 data.body.item_song，总数在 data.meta.estimate_sum
    # （TS 侧写的是 body.item_song / meta.estimate_sum，其中 body 即此处的 data）。
    inner = data.get("body")
    meta = data.get("meta")
    songs = handle_result(inner.get("item_song") if isinstance(inner, dict) else None)
    total = (meta.get("estimate_sum") or 0) if isinstance(meta, dict) else 0
    return {
        "list": songs,
        "allPage": -(-int(total) // limit) if total else 0,  # ceil 除法
        "limit": limit,
        "total": total,
        "source": "tx",
    }
