"""千千音乐搜索（对应 sdk/bd/musicSearch.ts）。

`/v1/search?word=&type=1&pageNo=&pageSize=`，appid + 签名。
响应 `data.typeTrack[]`：TSID/title/albumTitle/albumAssetCode/pic/duration/artist/rateFileInfo/isVip。

注：上游会跳过 isVip != 0 的曲目（VIP 无法匿名取流）；本实现保留并标记 payPlay，
以便聚合搜索/顺播时仍能展示（取流失败会返回明确错误，路由可走兜底链路）。
"""

from __future__ import annotations

import math
from typing import Any

from app.sdk.platforms.bd.util import APP_ID, api_get, api_ok, error_text, map_track, to_int, to_number


async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    word = str(keyword if keyword is not None else "").strip()
    if not word:
        return {"list": [], "allPage": 1, "total": 0, "limit": limit, "source": "bd"}

    body = await api_get(
        "/v1/search",
        {"word": word, "type": "1", "pageNo": str(page), "pageSize": str(limit), "appid": APP_ID},
    )
    # 23001 = 服务端不认该搜索类型/关键词，与原文一致：按空结果处理而不是报错
    if not api_ok(body) and to_number(body.get("errno") if isinstance(body, dict) else None) != 23001:
        raise RuntimeError(error_text(body, "千千搜索失败"))

    data = (body.get("data") if isinstance(body, dict) else None) or {}
    tracks = data.get("typeTrack") if isinstance(data, dict) else None
    raw = tracks if isinstance(tracks, list) else []
    total = to_int(data.get("total") if isinstance(data, dict) else None, len(raw))
    have_more = to_number(data.get("haveMore") if isinstance(data, dict) else None) == 1

    songs = [song for song in (map_track(item) for item in raw) if song["songmid"]]
    page_size = max(1, limit)
    all_page = page + 1 if have_more else max(page, math.ceil(total / page_size) or 1)

    return {"list": songs, "allPage": all_page, "total": total, "limit": limit, "source": "bd"}
