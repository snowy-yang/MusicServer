"""懒人听书搜索（对应 sdk/lr/musicSearch.ts，App 通道，游客匿名）。

接口: /yyting/search/searchBatch.action?keyWord=&searchOption=1&pageSize=&type=0&q=2150
实测（2026-10-02）匿名可用；结果分 data.bookResult/albumResult/folderResult/...
书籍条目字段：id(baseEntityId 同值)/name/announcer/cover
"""

from __future__ import annotations

import math
from typing import Any

from app.sdk.common.utils import as_dict, as_list
from app.sdk.platforms.lr.app_api import app_api_get


async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    del retry_num  # 契约参数，游客搜索无重试语义
    body = await app_api_get(
        "/yyting/search/searchBatch.action",
        {
            "keyWord": keyword,
            "searchOption": "1",
            "pageSize": str(limit),
            "type": str(page - 1),
            "q": "2150",
        },
    )
    api_status = body.get("apiStatus")
    if api_status is not None and api_status != 0:
        raise RuntimeError(str(body.get("msg") or f"搜索失败（code {api_status}）"))
    book_result = as_dict(as_dict(body.get("data")).get("bookResult"))
    books = [item for item in as_list(book_result.get("list")) if isinstance(item, dict)]
    total = int(book_result.get("count") or len(books))
    return {
        "allPage": math.ceil(total / limit) or page,
        "total": total,
        "limit": limit,
        "source": "lr",
        "list": [
            {
                "songmid": str(item.get("id", item.get("baseEntityId"))),
                "name": item.get("name") or "",
                "singer": item.get("announcer") or item.get("author") or "",
                "albumId": "",
                "albumName": "",
                "interval": 0,
                "payPlay": False,
                "img": item.get("cover") or None,
                "lrc": "",
                "lrcx": "",
                "types": [],
                "_types": {},
                "disabled": False,
            }
            for item in books
        ],
    }
