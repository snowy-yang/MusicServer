"""网易云热搜词（移植自 sdk/wy/hotSearch.ts）。"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.wy.utils import eapi_request


def filter_list(raw_list: Any) -> list[str]:
    return [str(item.get("searchWord")) for item in raw_list or [] if isinstance(item, dict) and item.get("searchWord")]


async def get_list(retry_num: int = 0) -> dict[str, Any]:
    """热搜词列表。失败文案与原文一致：获取热搜词失败。"""
    if retry_num > 2:
        raise RuntimeError("try max num")

    resp = await eapi_request("/api/search/chart/detail", {"id": "HOT_SEARCH_SONG#@#"})
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 200:
        raise RuntimeError("获取热搜词失败")

    data = body.get("data") or {}
    return {"source": "wy", "list": filter_list(data.get("itemList"))}
