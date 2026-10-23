"""酷我封面（对应 sdk/kw/pic.ts）。

`artistpicserver.kuwo.cn/pic.web` 返回的是一段纯文本（不是 JSON），内容就是图片 URL；
取不到时返回 `None`（原实现用 `/^http/` 判定，不匹配即 null）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch

PIC_API = "http://artistpicserver.kuwo.cn/pic.web"
PIC_PARAMS = "corp=kuwo&type=rid_pic&pictype=500&size=500"


async def get_pic(song_info: dict[str, Any]) -> str | None:
    songmid = str(song_info.get("songmid") or "")
    resp = await http_fetch(f"{PIC_API}?{PIC_PARAMS}&rid={songmid}")
    text = resp.body if isinstance(resp.body, str) else ""
    text = text.strip()
    return text if text.startswith("http") else None
