"""蜻蜓FM 搜索（对应 sdk/qt/musicSearch.ts，官网 SSR 频道结果页解析）。

接口: https://www.qingting.fm/search/channel_ondemand/<keyword>（302 → www.qtfm.cn，见 http.py）
实测（2026-10-02）SSR 渲染且与关键词强相关；?keyword= 混合页的结果区为客户端渲染
（服务端只吐热门推荐），JSON 搜索端点（webapi/webbff/searchapi）均 404——本页是唯一匿名搜索通道。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.platforms.fivesing.util import encode_uri_component
from app.sdk.platforms.qt.http import ssr_get


async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    del retry_num  # 契约参数，SSR 搜索无重试语义
    result = await ssr_get(
        f"https://www.qingting.fm/search/channel_ondemand/{encode_uri_component(keyword)}?page={page}"
    )
    if result["statusCode"] != 200:
        raise RuntimeError(f"搜索失败（HTTP {result['statusCode']}）")
    html = str(result["html"])

    # 结果项：href=/channels/<id> … <span title="<名称>">，封面在随后的 img src
    items = []
    for match in re.finditer(r'href="/channels/(\d+)"[\s\S]{0,400}?<span title="([^"]*)">', html):
        after = html[match.start() : match.start() + 700]
        img = re.search(r'<img src="(http[^"]+)"', after)
        items.append(
            {
                "songmid": match.group(1),
                "name": match.group(2),
                "singer": "",
                "albumId": "",
                "albumName": "",
                "interval": 0,
                "img": img.group(1).replace("http://", "https://") if img else None,
                "lrc": "",
                "lrcx": "",
                "types": [],
                "_types": {},
                "disabled": False,
            }
        )
    songs = [item for item in items if item["name"]][:limit]
    return {
        "allPage": page + (1 if len(songs) >= 10 else 0),
        "total": len(songs),
        "limit": limit,
        "source": "qt",
        "list": songs,
    }
