"""酷我热搜（对应 sdk/kw/hotSearch.ts）。"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch

HOT_API = (
    "http://hotword.kuwo.cn/hotword.s?prod=kwplayer_ar_9.3.0.1&corp=kuwo&newver=2"
    "&vipver=9.3.0.1&source=kwplayer_ar_9.3.0.1_40.apk&p2p=1&notrace=0&uid=0"
    "&plat=kwplayer_ar&rformat=json&encoding=utf8&tabid=1"
)

# 该接口只认移动端 Dalvik UA，桌面 UA 会返回非 JSON
HEADERS = {"User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9;)"}


def _filter_list(raw_list: list[dict[str, Any]]) -> list[str]:
    return [str(item.get("key") or "") for item in raw_list]


async def get_list() -> dict[str, Any]:
    resp = await http_fetch(HOT_API, headers=HEADERS)
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("status") != "ok":
        raise RuntimeError("获取热搜词失败")
    return {"source": "kw", "list": _filter_list(body.get("tagvalue") or [])}
