"""懒人听书 URL 获取（对应 sdk/apis/lr.ts，web 通道 getPlayPath，需登录）。

接口: https://m.lrts.me/ajax/getPlayPath?entityId=<bookId>&entityType=3&opType=1&sections=[<section>]&type=0
实测（2026-10-02）：免费章节匿名也返回 status=2 "收费章节未购买"——必须携带 /login/lr 登录会话；
成功响应 list[0].path 为音频直链。

songmid 为复合 id ``<bookId>:<section>``（/album/lr 章节列表产出）；纯 bookId 视为第一章。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.auth.lr import get_lr_cookie
from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict, as_list

UA_MI = (
    "Mozilla/5.0 (Linux; U; Android 4.1.1; zh-cn; MI2 Build/JRO03L) AppleWebKit/534.30 "
    "(KHTML, like Gecko) Version/4.0 Mobile Safari/534.30 XiaoMi/MiuiBrowser/1.0"
)
PLAY_URL = "https://m.lrts.me/ajax/getPlayPath"

SUPPORT_QUALITYS: list[str] = ["64k", "128k"]


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    del retry_num  # 契约参数，无重试语义
    songmid = str(song_info.get("songmid") or "")
    parts = songmid.split(":")
    book_id = parts[0] if parts else ""
    section = parts[1] if len(parts) > 1 and parts[1] else "1"

    if not book_id or not re.fullmatch(r"\d+", book_id):
        raise RuntimeError("懒人 id 需为 <bookId>[:<section>]（见 /album/lr 章节列表）")
    cookie = get_lr_cookie()
    if not cookie:
        raise RuntimeError("懒人听书取流需要登录（POST /login/lr 绑定账号密码）")

    resp = await http_fetch(
        f"{PLAY_URL}?entityId={book_id}&entityType=3&opType=1&sections=[{section}]&type=0",
        headers={"User-Agent": UA_MI, "Referer": "https://m.lrts.me/", "Cookie": cookie},
        timeout=15_000,
    )
    body = as_dict(resp.body)
    if resp.status_code != 200:
        raise RuntimeError(f"取流失败（HTTP {resp.status_code}）")
    items = as_list(body.get("list"))
    path = as_dict(items[0]).get("path") if items else None
    if not path:
        if body.get("status") == 2:
            raise RuntimeError(str(body.get("msg") or "收费章节未购买（需账号已购/会员）"))
        if "登录" in str(body.get("msg") or ""):
            raise RuntimeError("登录态已失效，请重新 POST /login/lr")
        raise RuntimeError(str(body.get("msg") or "取流失败"))
    return {"type": "128k" if quality == "128k" else "64k", "url": str(path)}
