"""懒人听书登录（对应 sdk/lr/auth.ts，web 通道 m.lrts.me/ajax/logon）。

参考社区下载器（yoval/lrts 等）：POST form {account, pwd: base64(password)}，
成功响应 json.phone 非空，Set-Cookie 种下会话；取流接口必须携带该会话
（免费章节匿名也返回"收费章节未购买"，2026-10-02 实测）。
"""

from __future__ import annotations

import base64
from typing import Any
from urllib.parse import quote

from app.http.api_error import ApiError
from app.sdk.auth_store import get_credentials, set_credentials
from app.sdk.common.request import http_fetch

UA_MI = (
    "Mozilla/5.0 (Linux; U; Android 4.1.1; zh-cn; MI2 Build/JRO03L) AppleWebKit/534.30 "
    "(KHTML, like Gecko) Version/4.0 Mobile Safari/534.30 XiaoMi/MiuiBrowser/1.0"
)
LOGON_URL = "https://m.lrts.me/ajax/logon"


async def login(account: str, password: str) -> dict[str, Any]:
    """账号密码登录（成功保存会话 Cookie）。"""
    form = f"account={quote(str(account), safe='')}&pwd={base64.b64encode(str(password).encode()).decode()}"
    resp = await http_fetch(
        LOGON_URL,
        method="POST",
        headers={
            "User-Agent": UA_MI,
            "Referer": "https://m.lrts.me/",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body=form,
        timeout=15_000,
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or not body.get("phone"):
        raise ApiError(401, str(body.get("msg") or "登录失败（账号或密码错误）"))
    cookie = "; ".join(part for part in (item.split(";")[0].strip() for item in resp.set_cookies) if part)
    if not cookie:
        raise RuntimeError("登录成功但未返回会话 Cookie")
    set_credentials("lr", {"cookie": cookie, "phone": str(body["phone"])})
    return {"logged": True, "phone": str(body["phone"])}


def get_lr_cookie() -> str:
    """登录会话 Cookie（未登录返回空串）。"""
    return str((get_credentials("lr") or {}).get("cookie") or "")


def status() -> dict[str, Any]:
    """登录状态。"""
    cred = get_credentials("lr") or {}
    if cred.get("cookie"):
        return {"logged": True, "phone": cred.get("phone"), "updatedAt": cred.get("updatedAt")}
    return {"logged": False}
