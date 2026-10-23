"""Bilibili 搜索（对应 sdk/bili/musicSearch.ts，上游 bilibili/song.go 的 ``Search``）。

接口: x/web-interface/search/type?search_type=video

上游对每个搜索结果再调 x/web-interface/view 取首个分P的 cid/时长（B 站取流必须 cid），
本移植保持一致，只是把逐个串行改成 4 并发；单条 view 失败按上游语义跳过该条。

实测（2026-10-02）：带 Referer/UA + 匿名（或登录）Cookie 可返回 code 0；
风控时返回 -412/-352，会抛错由路由兜底。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.bili.util import (
    api_get,
    as_dict,
    as_list,
    clean_title,
    encode_uri_component,
    fetch_view,
    make_song,
    map_limit,
    to_number,
)

SEARCH_URL = "https://api.bilibili.com/x/web-interface/search/type"


async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    del retry_num  # 契约参数，B 站搜索无重试语义
    p = max(1, int(to_number(page)) or 1)
    size = min(max(1, int(to_number(limit)) or 20), 50)
    url = f"{SEARCH_URL}?search_type=video&keyword={encode_uri_component(keyword)}&page={p}&page_size={size}"
    resp = await api_get(url)
    body = resp.body
    if resp.status_code != 200 or not isinstance(body, dict):
        raise RuntimeError(f"B站搜索失败（HTTP {resp.status_code}）")
    if body.get("code") != 0:
        message = body.get("message")
        raise RuntimeError(f"B站搜索失败（{body.get('code')}{f': {message}' if message else ''}）")

    data = as_dict(body.get("data"))
    items = as_list(data.get("result"))

    async def one(item: Any, _index: int) -> dict[str, Any] | None:
        if not isinstance(item, dict) or not item.get("bvid"):
            return None
        view = await fetch_view(item["bvid"])
        pages = as_list(view.get("pages"))
        if not pages:
            return None
        first = pages[0] if isinstance(pages[0], dict) else {}
        root_title = clean_title(item.get("title"))
        display_title = str(first.get("part") or "")
        if not display_title:
            display_title = root_title
        elif display_title != root_title:
            display_title = f"{root_title} - {display_title}"
        owner = as_dict(view.get("owner"))
        return make_song(
            bvid=str(item["bvid"]),
            cid=first.get("cid"),
            name=display_title,
            artist=str(item.get("author") or owner.get("name") or ""),
            album=str(item["bvid"]),
            duration=first.get("duration"),
            cover=str(item.get("pic") or view.get("pic") or ""),
            page=1,
        )

    songs = await map_limit(items, 4, one)
    result = [song for song in songs if song]
    total = int(to_number(data.get("numResults"))) or len(result)
    num_pages = int(to_number(data.get("numPages")))
    return {
        "list": result,
        "allPage": num_pages or p + (1 if len(result) >= size else 0),
        "total": total,
        "limit": size,
        "source": "bili",
    }
