"""喜马拉雅搜索（对应 sdk/xm/musicSearch.ts，web 通道）。

接口: https://www.ximalaya.com/revision/search?core=track&kw=&page=&rows=&spellchecker=true&condition=relation&device=web
实测（2026-10-02）匿名可用（注意：同参数的 /revision/search/main 与 /search/main 会命中
risk invalid 风控，本端点 + condition=relation&device=web 不受影响）。

返回 data.result.response.docs[]，字段 id/title/duration(秒)/nickname/album_id/album_title/
album_cover_path/is_paid/is_trailer。
"""

from __future__ import annotations

import math
from typing import Any
from urllib.parse import urlencode

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict, as_list, format_play_time
from app.sdk.platforms.xm.sign import XM_UA

SEARCH_URL = "https://www.ximalaya.com/revision/search"


def _normalize_cover(path: Any) -> str | None:
    if not path:
        return None
    text = str(path)
    return text if text.startswith("http") else f"https://imagev2.xmcdn.com/{text}"


async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    del retry_num  # 契约参数，web 搜索无重试语义
    params = urlencode(
        {
            "core": "track",
            "kw": keyword,
            "page": str(page),
            "rows": str(limit),
            "spellchecker": "true",
            "condition": "relation",
            "device": "web",
        }
    )
    resp = await http_fetch(
        f"{SEARCH_URL}?{params}",
        headers={
            "User-Agent": XM_UA,
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.ximalaya.com/",
        },
        timeout=15_000,
    )
    body = as_dict(resp.body)
    if resp.status_code != 200 or body.get("ret") != 200:
        raise RuntimeError(str(body.get("msg") or "搜索失败"))
    response = as_dict(as_dict(as_dict(as_dict(body.get("data")).get("result")).get("response")))
    docs = [item for item in as_list(response.get("docs")) if isinstance(item, dict)]
    total = int(response.get("numFound") or len(docs))
    songs = []
    for item in docs:
        duration = item.get("duration")
        songs.append(
            {
                "songmid": str(item.get("id")),
                "name": item.get("title") or "",
                "singer": item.get("nickname") or "",
                "albumId": str(item["album_id"]) if item.get("album_id") else "",
                "albumName": item.get("album_title") or "",
                "interval": format_play_time(float(duration)) if duration else 0,
                "payPlay": bool(item.get("is_paid")),
                "img": _normalize_cover(item.get("album_cover_path")),
                "lrc": "",
                "lrcx": "",
                "types": [],
                "_types": {},
                "disabled": False,
            }
        )
    return {
        "allPage": math.ceil(total / limit) or page,
        "total": total,
        "limit": limit,
        "source": "xm",
        "list": songs,
    }
