"""懒人听书章节列表（对应 sdk/lr/menu.ts，web 通道，匿名免签）。

接口: https://m.lrts.me/ajax/getBookMenu?bookId=&pageNum=&pageSize=&sortType=0
实测（2026-10-02）匿名可用；章节条目 {section, name, listenPrice, state}
注意：专辑类内容用 getAlbumAudios（entityType=2），本实现仅收书（entityType=3）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict, as_list

UA_MI = (
    "Mozilla/5.0 (Linux; U; Android 4.1.1; zh-cn; MI2 Build/JRO03L) AppleWebKit/534.30 "
    "(KHTML, like Gecko) Version/4.0 Mobile Safari/534.30 XiaoMi/MiuiBrowser/1.0"
)
MENU_URL = "https://m.lrts.me/ajax/getBookMenu"


async def get_book_menu(book_id: str, page: int = 1, limit: int = 30) -> dict[str, Any]:
    resp = await http_fetch(
        f"{MENU_URL}?bookId={book_id}&pageNum={page}&pageSize={max(30, limit)}&sortType=0",
        headers={"User-Agent": UA_MI, "Referer": "https://m.lrts.me/"},
        timeout=15_000,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"获取章节失败（HTTP {resp.status_code}）")
    body = as_dict(resp.body)
    if body.get("status") == 1 or not body.get("list"):
        raise RuntimeError(str(body.get("msg") or "获取章节失败"))
    return {"total": int(body.get("sections") or 0), "list": as_list(body.get("list"))}
