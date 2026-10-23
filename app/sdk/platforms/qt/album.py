"""蜻蜓FM 频道节目列表（对应 sdk/qt/album.ts，官网 SSR 页解析）。

接口: https://www.qingting.fm/channels/<id>（302 → www.qtfm.cn，见 http.py）
实测（2026-10-02）SSR 输出含节目表格：a.pTitle href=/channels/<cid>/programs/<pid> + p[title] + span.col2 时长
节目条目的 songmid 采用复合 id ``<channelId>:<programId>``（取流签名需要两者）。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.platforms.qt.http import ssr_get


def _decode_entities(text: str) -> str:
    return (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )


async def _fetch_channel_html(channel_id: str) -> str:
    result = await ssr_get(f"https://www.qingting.fm/channels/{channel_id}")
    if result["statusCode"] != 200:
        raise RuntimeError(f"获取频道失败（HTTP {result['statusCode']}）")
    return str(result["html"])


async def get_channel_programs(channel_id: str) -> dict[str, Any]:
    html = await _fetch_channel_html(channel_id)

    title_match = re.search(r"<title>([^<]*)<", html)
    raw_name = title_match.group(1).split("-")[0].strip() if title_match else ""
    name = _decode_entities(raw_name or str(channel_id))

    songs = []
    for match in re.finditer(r'href="/channels/(\d+)/programs/(\d+)"[^>]*>\s*<p[^>]*title="([^"]*)"', html):
        songs.append(
            {
                "songmid": f"{match.group(1)}:{match.group(2)}",
                "name": _decode_entities(match.group(3)) or f"节目 {match.group(2)}",
                "singer": name,
                "albumId": str(channel_id),
                "albumName": name,
                "interval": 0,
                "payPlay": False,
                "img": None,
                "lrc": "",
                "lrcx": "",
                "types": [],
                "_types": {},
                "disabled": False,
            }
        )
    return {"name": name, "list": songs}


async def get_channel_og_image(channel_id: str) -> str | None:
    """频道封面（SSR 页 og:image）。"""
    html = await _fetch_channel_html(channel_id)
    match = re.search(r'property="og:image"\s+content="([^"]+)"', html) or re.search(
        r'content="([^"]+)"\s+property="og:image"', html
    )
    return match.group(1).replace("http://", "https://") if match else None
