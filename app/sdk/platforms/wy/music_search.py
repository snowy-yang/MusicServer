"""网易云搜索（移植自 sdk/wy/musicSearch.ts）。

走 eapi 通道 /api/search/song/list/page（cloudsearch pc 已被注释掉，保留原样）。
响应结构是 resources[].baseInfo.simpleSongData，与 song/detail 的扁平结构不同，
因此音质解析单独一份（privilege 内嵌在 simpleSongData 里）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.utils import format_play_time, size_formate
from app.sdk.platforms.wy.utils import eapi_request

DEFAULT_LIMIT = 30

# 模块级状态与原 TS 一致（路由不读这些字段，但 allPage/total 由它们推导）
_state: dict[str, Any] = {"total": 0, "page": 0, "all_page": 1, "limit": DEFAULT_LIMIT}


def get_singer(singers: Any) -> str:
    return "、".join(str(singer.get("name")) for singer in singers or [] if isinstance(singer, dict))


def _size_of(block: Any) -> str | None:
    if isinstance(block, dict) and block.get("size"):
        return size_formate(block["size"])
    return None


def handle_result(raw_list: Any) -> list[dict[str, Any]]:
    if not raw_list:
        return []
    rows: list[dict[str, Any]] = []
    for raw in raw_list:
        item = ((raw or {}).get("baseInfo") or {}).get("simpleSongData") or {}
        privilege = item.get("privilege") or {}
        types: list[dict[str, Any]] = []
        _types: dict[str, dict[str, Any]] = {}

        if privilege.get("maxBrLevel") == "hires":
            size = _size_of(item.get("hr"))
            types.append({"type": "flac24bit", "size": size})
            _types["flac24bit"] = {"size": size}

        maxbr = privilege.get("maxbr")
        # 无 break 的 switch 直落：高码率同时声明向下兼容档位
        if maxbr in (999000, 320000, 192000, 128000):
            if maxbr == 999000:
                size = _size_of(item.get("sq"))
                types.append({"type": "flac", "size": size})
                _types["flac"] = {"size": size}
            if maxbr in (999000, 320000):
                size = _size_of(item.get("h"))
                types.append({"type": "320k", "size": size})
                _types["320k"] = {"size": size}
            size = _size_of(item.get("l"))
            types.append({"type": "128k", "size": size})
            _types["128k"] = {"size": size}

        types.reverse()

        album = item.get("al") or {}
        rows.append(
            {
                "singer": get_singer(item.get("ar")),
                "name": item.get("name"),
                "albumName": album.get("name"),
                "albumId": album.get("id"),
                "source": "wy",
                "interval": format_play_time((item.get("dt") or 0) / 1000),
                "songmid": item.get("id"),
                "img": album.get("picUrl"),
                "lrc": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return rows


async def _music_search(keyword: str, page: int, limit: int) -> Any:
    resp = await eapi_request(
        "/api/search/song/list/page",
        {
            "keyword": keyword,
            "needCorrect": "1",
            "channel": "typing",
            "offset": limit * (page - 1),
            "scene": "normal",
            "total": page == 1,
            "limit": limit,
        },
    )
    return resp.body


async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    """搜索单曲。失败重试上限 3 次（文案与原文一致：try max num）。"""
    retry_num += 1
    if retry_num > 3:
        raise RuntimeError("try max num")
    if not limit:
        limit = DEFAULT_LIMIT

    result = await _music_search(keyword, page, limit)
    if not isinstance(result, dict) or result.get("code") != 200:
        return await search(keyword, page, limit, retry_num)

    data = result.get("data") or {}
    rows = handle_result(data.get("resources") or [])

    _state["total"] = data.get("totalCount") or 0
    _state["page"] = page
    _state["all_page"] = -(-int(_state["total"]) // DEFAULT_LIMIT)  # ceil 除法
    _state["limit"] = DEFAULT_LIMIT

    return {
        "list": rows,
        "allPage": _state["all_page"],
        "limit": DEFAULT_LIMIT,
        "total": _state["total"],
        "source": "wy",
    }
