"""哔哩哔哩扫码登录（对应 sdk/bili/login.ts，上游 bilibili/login.go + account.go 的 IsVipAccount）。

接口:
  * GET passport.bilibili.com/x/passport-login/web/qrcode/generate → data.{url, qrcode_key}
  * GET passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key= → data.code
        0 成功 / 86038 过期 / 86090 已扫码待确认 / 86101 未扫码

成功时登录态 Cookie 在 poll 响应的 Set-Cookie 与 data.url 的 crossDomain 查询串里（两处都收集）。
凭据落盘到 auth_store 的 ``bili`` 记录（cookie / refreshToken / 账号资料），与 kg/wy 一致；
上游 ``New(cookie)`` 的实例化语义由 ``get_credentials('bili')`` 承担（见 platforms/bili/util.py）。

状态码沿用本仓库约定：800 过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功。
"""

from __future__ import annotations

import random
import time
from typing import Any
from urllib.parse import parse_qs, urlsplit

from app.http.api_error import ApiError
from app.sdk.auth_store import get_credentials, set_credentials
from app.sdk.common.qrcode import to_data_url
from app.sdk.common.request import http_fetch
from app.sdk.platforms.bili.util import REFERER, UA, as_dict

QR_GENERATE_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
QR_POLL_API = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"

#: 上游 utils.WithRandomIPHeader：随机国内 IP，规避部分区域限制
_CHINA_IP_FIRST = [
    36,
    42,
    58,
    60,
    101,
    106,
    110,
    111,
    112,
    113,
    114,
    115,
    116,
    117,
    118,
    119,
    120,
    121,
    122,
    123,
    124,
    125,
    171,
    175,
    180,
    182,
    183,
    210,
    211,
    218,
    219,
    220,
    221,
    222,
    223,
]

_CROSS_DOMAIN_KEYS = ("DedeUserID", "DedeUserID__ckMd5", "SESSDATA", "bili_jct", "sid")


def _random_china_ip() -> str:
    first = random.choice(_CHINA_IP_FIRST)
    return f"{first}.{random.randint(1, 254)}.{random.randint(1, 254)}.{random.randint(1, 254)}"


def _qr_headers() -> dict[str, str]:
    ip = _random_china_ip()
    return {"User-Agent": UA, "Referer": REFERER, "X-Forwarded-For": ip, "X-Real-IP": ip}


def _cookie_map(cookie_lines: list[str]) -> dict[str, str]:
    jar: dict[str, str] = {}
    for value in cookie_lines:
        pair = str(value).split(";")[0].strip()
        idx = pair.find("=")
        if idx > 0:
            jar[pair[:idx].strip()] = pair[idx + 1 :].strip()
    return jar


def _cookie_map_from_cross_domain(cross_url: str) -> dict[str, str]:
    """crossDomain 回跳地址的查询串里也带 SESSDATA 等（无 cookie 包时后备）。"""
    jar: dict[str, str] = {}
    try:
        query = parse_qs(urlsplit(str(cross_url or "")).query)
    except ValueError:
        return jar
    for name in _CROSS_DOMAIN_KEYS:
        values = query.get(name)
        if values:
            jar[name] = values[0]
    return jar


def _cookie_string(jar: dict[str, str]) -> str:
    return "; ".join(f"{key}={value}" for key, value in jar.items())


async def create_qr_login() -> dict[str, Any]:
    """创建扫码登录会话：返回 ``{key, qrurl, qrimg, expiresAt}``（qrimg 可直接展示）。"""
    resp = await http_fetch(QR_GENERATE_API, headers=_qr_headers(), timeout=15_000)
    body = resp.body
    if resp.status_code != 200 or not isinstance(body, dict):
        raise RuntimeError(f"获取B站登录二维码失败（HTTP {resp.status_code}）")
    data = as_dict(body.get("data"))
    key = str(data.get("qrcode_key") or "").strip()
    if body.get("code") != 0 or not key:
        message = body.get("message")
        raise RuntimeError(f"获取B站登录二维码失败（{body.get('code')}{f': {message}' if message else ''}）")
    url = str(data.get("url") or "")
    qrimg = ""
    try:
        qrimg = to_data_url(url)
    except Exception:  # noqa: BLE001 - 二维码渲染失败不影响 key/url 返回
        qrimg = ""
    return {
        "key": key,
        "qrurl": url,
        "qrimg": qrimg,
        # 上游 QRLoginSession.ExpiresAt：3 分钟有效期
        "expiresAt": int(time.time()) + 180,
    }


async def _fetch_profile(cookie: str) -> dict[str, Any]:
    """拉取账号资料（nav；失败不阻断登录）。"""
    try:
        resp = await http_fetch(
            "https://api.bilibili.com/x/web-interface/nav",
            headers={"User-Agent": UA, "Referer": REFERER, "Cookie": cookie},
            timeout=15_000,
        )
        body = as_dict(resp.body)
        data = as_dict(body.get("data"))
        return {
            "mid": data.get("mid"),
            "nickname": data.get("uname"),
            "vipType": int(data.get("vipType") or 0),
            "vipStatus": int(data.get("vipStatus") or 0),
        }
    except Exception:  # noqa: BLE001 - 资料失败不阻断登录
        return {"mid": None, "nickname": None, "vipType": 0, "vipStatus": 0}


async def _poll(key: str) -> tuple[int, list[str], Any]:
    """轮询请求（http_fetch 的 set_cookies 保留全部 Set-Cookie，登录凭据靠它取）。"""
    url = f"{QR_POLL_API}?qrcode_key={key}"
    resp = await http_fetch(url, headers={"User-Agent": UA, "Referer": REFERER}, timeout=15_000)
    return resp.status_code, resp.set_cookies, resp.body


async def check_qr_login(key: str) -> dict[str, Any]:
    """轮询扫码状态。

    返回 code：800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功（凭据已落盘）。
    """
    qrcode_key = str(key or "").strip()
    if not qrcode_key:
        raise RuntimeError("B站扫码 key 为空")
    status, cookie_lines, body = await _poll(qrcode_key)
    if status != 200:
        raise ApiError(502, f"轮询B站扫码状态失败（HTTP {status}）")
    data = as_dict(body.get("data")) if isinstance(body, dict) else {}
    code = int(data.get("code") or 0)

    if code == 0:
        jar = {**_cookie_map_from_cross_domain(data.get("url") or ""), **_cookie_map(cookie_lines)}
        cookie = _cookie_string(jar)
        if not cookie:
            raise RuntimeError("B站登录成功但未获取到 Cookie，请重试")
        profile = await _fetch_profile(cookie)
        set_credentials(
            "bili",
            {
                "cookie": cookie,
                "refreshToken": str(data.get("refresh_token") or ""),
                "mid": profile["mid"],
                "nickname": profile["nickname"],
                "vipType": profile["vipType"],
                "vipStatus": profile["vipStatus"],
            },
        )
        from app.sdk.apis.bili import reset_vip_cache

        reset_vip_cache()
        return {"code": 803, "message": "登录成功", "status": "success", "profile": profile}

    status_map: dict[int, tuple[int, str, str]] = {
        86038: (800, "二维码已过期", "expired"),
        86090: (802, "已扫码，待确认", "scanned"),
        86101: (801, "等待扫码", "waiting"),
    }
    if code in status_map:
        mapped, message, state = status_map[code]
        return {"code": mapped, "message": message, "status": state}
    message = data.get("message") or f"未知状态 {code}"
    return {"code": 800, "message": str(message), "status": "failed"}


def status() -> dict[str, Any]:
    """当前登录态（凭据存在性 + 落盘时保存的账号资料）。"""
    cred = get_credentials("bili") or {}
    if cred.get("cookie"):
        return {
            "logged": True,
            "nickname": cred.get("nickname"),
            "mid": cred.get("mid"),
            "vipType": cred.get("vipType") or 0,
            "updatedAt": cred.get("updatedAt"),
        }
    return {"logged": False}
