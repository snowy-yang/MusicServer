"""酷狗热搜（对应 sdk/kg/hotSearch.ts）。"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import decode_name

HOT_API = (
    "http://gateway.kugou.com/api/v3/search/hot_tab"
    "?signature=ee44edb9d7155821412d220bcaf509dd&appid=1005&clientver=10026&plat=0"
)

HEADERS = {
    "dfid": "1ssiv93oVqMp27cirf2CvoF1",
    "mid": "156798703528610303473757548878786007104",
    "clienttime": "1584257267",
    "x-router": "msearch.kugou.com",
    "user-agent": "Android9-AndroidPhone-10020-130-0-searchrecommendprotocol-wifi",
    "kg-rc": "1",
}


def _filter_list(raw_list: list[dict[str, Any]]) -> list[str]:
    result: list[str] = []
    for item in raw_list:
        for keyword in item.get("keywords") or []:
            result.append(decode_name(keyword.get("keyword")))
    return result


async def get_list(retry_num: int = 0) -> dict[str, Any]:
    if retry_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(HOT_API, method="get", headers=HEADERS)
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("errcode") != 0:
        raise RuntimeError("获取热搜词失败")
    data = body.get("data") or {}
    return {"source": "kg", "list": _filter_list(data.get("list") or [])}
