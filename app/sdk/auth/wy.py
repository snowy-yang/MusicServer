"""网易云登录（对应 sdk/auth/wy.ts）—— 扫码 / 手机号 / cookie 绑定，weapi 加密请求。

参考实现：NeteaseCloudMusicApi（login_qr_key / login_qr_check / login_cellphone / login_status）。
二维码接口只提供明文 api 形态（weapi 形态已 404）；其余登录接口走 weapi。
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from app.http.api_error import ApiError
from app.sdk.auth_store import get_wy_cookie, set_credentials
from app.sdk.common.qrcode import to_data_url
from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict
from app.sdk.platforms.wy.utils.crypto import weapi

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


async def _request_weapi(path: str, data: Any, cookie: str | None = None) -> tuple[Any, list[str]]:
    ck = get_wy_cookie() if cookie is None else cookie
    headers = {
        "User-Agent": UA,
        "origin": "https://music.163.com",
        "Referer": "https://music.163.com/",
    }
    if ck:
        headers["cookie"] = ck
    resp = await http_fetch(
        f"https://music.163.com/weapi{path}",
        method="POST",
        headers=headers,
        form=weapi(data),
        timeout=15_000,
    )
    if resp.status_code != 200:
        raise RuntimeError("网易请求失败")
    return resp.body, resp.set_cookies


async def _request_api(path: str, data: Any) -> tuple[Any, list[str]]:
    """明文 api 请求（二维码接口只提供该形态）。"""
    resp = await http_fetch(
        f"https://music.163.com{path}",
        method="POST",
        headers={"User-Agent": UA, "origin": "https://music.163.com", "Referer": "https://music.163.com/"},
        form=data,
        timeout=15_000,
    )
    if resp.status_code != 200:
        raise RuntimeError("网易请求失败")
    return resp.body, resp.set_cookies


def _extract_login_cookie(set_cookie: list[str]) -> tuple[str, str]:
    """从 Set-Cookie 数组提取登录 cookie 串与 MUSIC_U。"""
    joined = "; ".join(part for part in (item.split(";")[0].strip() for item in set_cookie) if part)
    match = re.search(r"MUSIC_U=([^;]+)", joined)
    return joined, match.group(1) if match else ""


async def _fetch_profile(cookie: str | None = None) -> dict[str, Any]:
    """登录成功后拉取账号资料（cookie 显式传入新登录会话，避免首次登录读到旧 cookie）。"""
    body, _ = await _request_weapi("/api/w/nuser/account/get", {}, cookie)
    body = as_dict(body)
    account = as_dict(body.get("account"))
    profile = as_dict(body.get("profile"))
    return {
        "userid": account.get("id"),
        "nickname": profile.get("nickname"),
        "avatar": profile.get("avatarUrl"),
        "vipType": profile.get("vipType"),
    }


async def _apply_login(set_cookie: list[str]) -> dict[str, Any]:
    """应用登录 cookie（成功后调用）。"""
    cookie, music_u = _extract_login_cookie(set_cookie)
    if not music_u:
        raise RuntimeError("登录响应中缺少 MUSIC_U")
    try:
        profile = await _fetch_profile(cookie)
    except Exception:  # noqa: BLE001 - 资料拉取失败不影响已成功的登录，返回空资料
        profile = {"userid": None, "nickname": None, "avatar": None, "vipType": None}
    set_credentials("wy", {"cookie": cookie, "musicU": music_u, **profile})
    return profile


async def qr_key() -> dict[str, Any]:
    """创建扫码登录 key 与二维码内容。"""
    body, _ = await _request_api("/api/login/qrcode/unikey", {"type": 3})
    body = as_dict(body)
    if body.get("code") != 200 or not body.get("unikey"):
        raise RuntimeError("获取二维码 key 失败")
    key = str(body["unikey"])
    qrurl = f"https://music.163.com/login?codekey={key}"
    qrimg = ""
    try:
        qrimg = to_data_url(qrurl)
    except Exception:  # noqa: BLE001 - 二维码渲染失败不影响 key/url 返回
        qrimg = ""
    return {"key": key, "qrurl": qrurl, "qrimg": qrimg}


async def qr_check(key: str) -> dict[str, Any]:
    """轮询扫码状态：800 过期 / 801 等待 / 802 已扫码 / 803 已授权（完成登录）。"""
    body, set_cookie = await _request_api("/api/login/qrcode/client/login", {"key": key, "type": 3})
    body = as_dict(body)
    code = body.get("code")
    if code == 803:
        profile = await _apply_login(set_cookie)
        return {"code": 803, "message": "登录成功", "profile": profile}
    messages: dict[Any, str] = {800: "二维码已过期", 801: "等待扫码", 802: "已扫码，待确认"}
    message = messages.get(code) or body.get("message") or "未知状态"
    return {"code": code, "message": message}


async def cellphone_login(
    phone: str, password: str | None = None, captcha: str | None = None, countrycode: str = "86"
) -> dict[str, Any]:
    """手机号登录（密码明文传入，本地 MD5 后提交；或直接传验证码 captcha）。"""
    data: dict[str, Any] = {
        "type": "1",
        "https": "true",
        "phone": phone,
        "countrycode": countrycode,
        "remember": "true",
    }
    if captcha:
        data["captcha"] = captcha
    else:
        data["password"] = hashlib.md5(str(password or "").encode()).hexdigest()
    body, set_cookie = await _request_weapi("/api/w/login/cellphone", data)
    body = as_dict(body)
    if body.get("code") != 200:
        raise ApiError(401, str(body.get("message") or body.get("msg") or "登录失败"))
    return await _apply_login(set_cookie)


async def login_by_cookie(cookie_input: str) -> dict[str, Any]:
    """手动绑定 cookie（须含 MUSIC_U）；绑定前用 account/get 实测校验。"""
    cookie = str(cookie_input or "").strip()
    match = re.search(r"MUSIC_U=([^;\s]+)", cookie)
    if not match:
        raise ApiError(422, "cookie 需包含 MUSIC_U 字段")
    body, _ = await _request_weapi("/api/w/nuser/account/get", {}, cookie)
    body = as_dict(body)
    account = as_dict(body.get("account"))
    if not account.get("id"):
        raise ApiError(401, "cookie 无效或已过期（MUSIC_U 校验未通过）")
    profile_body = as_dict(body.get("profile"))
    profile = {
        "userid": account.get("id"),
        "nickname": profile_body.get("nickname"),
        "avatar": profile_body.get("avatarUrl"),
        "vipType": profile_body.get("vipType"),
    }
    set_credentials("wy", {"cookie": cookie, "musicU": match.group(1), **profile})
    return profile


async def status() -> dict[str, Any] | None:
    """当前账号资料（未登录返回 None）。"""
    if not get_wy_cookie():
        return None
    return await _fetch_profile()
