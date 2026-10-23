"""QQ 音乐凭据（对应 sdk/auth/tx.ts）—— cookie 解析、扫码登录、VIP 检测与登录态续期。

续期走 musicu.fcg 未签名通道（与 apis/tx.py 一致）；Login/VipLogin 模块若拒绝未签名请求
则以 code != 0 失败，此时保留原凭据并抛错，由调用方记录日志。
续期条件：仅浏览器 cookie（无 openId 等抓包字段）时只带 musicid/musickey 尝试，失败率较高；
完整凭据（/login/tx 可选传入 openId/accessToken/refreshToken/refreshKey）最可靠。

扫码登录（参考 sansenjian/qq-music-api）：ptlogin 扫码 → check_sig →
graph.qq.com OAuth authorize 换 code → QQConnectLogin.LoginServer/QQLogin 换凭据，
成功响应体一般携带 refresh_key 等完整字段，可走自动续期。
"""

from __future__ import annotations

import base64
import random
import re
import time
from typing import Any
from urllib.parse import urlencode

from app.http.api_error import ApiError
from app.sdk.auth_store import get_credentials, set_credentials
from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)",
    "Referer": "https://y.qq.com/",
}


def parse_cookie(cookie: str) -> dict[str, str]:
    """解析 cookie 中的关键字段（uin / qm_keyst 即 musickey / tmeLoginType）。"""
    text = str(cookie or "")
    uin = re.search(r"uin=(\d+)", text)
    musickey = re.search(r"qm_keyst=([^;]+)", text)
    login_type = re.search(r"tmeLoginType=(\d+)", text)
    return {
        "uin": uin.group(1) if uin else "0",
        "musickey": musickey.group(1) if musickey else "",
        "tmeLoginType": login_type.group(1) if login_type else "",
    }


async def _musicu_request(data: dict[str, Any], cred: dict[str, Any] | None) -> dict[str, Any]:
    headers = dict(HEADERS)
    cookie = str((cred or {}).get("cookie") or "")
    if cookie:
        headers["cookie"] = cookie
    resp = await http_fetch(
        "https://u.y.qq.com/cgi-bin/musicu.fcg",
        method="POST",
        headers=headers,
        body=data,
        timeout=15_000,
    )
    return resp.body if isinstance(resp.body, dict) else {}


async def check_vip() -> str | None:
    """检测当前账号 VIP 等级（vip_login_base），结果写入凭据存储。

    成功返回 'svip' / 'vip' / 'normal'；请求失败返回 None（不改动已存值）。
    """
    cred = get_credentials("tx")
    if not cred or not cred.get("cookie"):
        return None
    uin = parse_cookie(str(cred["cookie"]))["uin"]
    body = await _musicu_request(
        {
            "comm": {"ct": "19", "cv": "1859", "uin": uin},
            "req": {"module": "VipLogin.VipLoginInter", "method": "vip_login_base", "param": {}},
        },
        cred,
    )
    req = as_dict(body.get("req"))
    if req.get("code") != 0:
        return None
    data = as_dict(req.get("data"))
    identity = as_dict(data.get("identity"))
    if identity.get("HugeVip"):
        vip_type = "svip"
    elif identity.get("LMFlag"):
        vip_type = "vip"
    else:
        vip_type = "normal"
    set_credentials("tx", {"vipType": vip_type})
    return vip_type


async def refresh_login() -> dict[str, Any]:
    """续期 tx 登录态（music.login.LoginServer），成功后写回新 musickey 并顺带检测 VIP。"""
    cred = get_credentials("tx")
    if not cred or not cred.get("cookie"):
        return {"skipped": True}
    parsed = parse_cookie(str(cred["cookie"]))
    uin, musickey = parsed["uin"], parsed["musickey"]
    if not musickey:
        raise RuntimeError("cookie 缺少 qm_keyst 字段")

    param: dict[str, Any] = {
        "musicid": int(uin) if uin.isdigit() else 0,
        "musickey": musickey,
        "loginMode": 2,
        "expired_in": 0,
    }
    # App 抓包的完整凭据（存在才携带）
    if cred.get("openId"):
        param["openid"] = cred["openId"]
    if cred.get("accessToken"):
        param["access_token"] = cred["accessToken"]
    if cred.get("refreshToken"):
        param["refresh_token"] = cred["refreshToken"]
    if cred.get("refreshKey"):
        param["refresh_key"] = cred["refreshKey"]

    body = await _musicu_request(
        {
            "comm": {"ct": "19", "cv": "1859", "uin": uin},
            "req": {"module": "music.login.LoginServer", "method": "Login", "param": param},
        },
        cred,
    )
    req = as_dict(body.get("req"))
    data = as_dict(req.get("data"))
    if req.get("code") != 0 or not data.get("musickey"):
        msg = f": {req['msg']}" if req.get("msg") else ""
        raise RuntimeError(f"刷新失败（code {req.get('code')}{msg}）")

    # musickey 可能含 $ 等字符：用函数替换，避免字符串替换里的分组转义被展开
    cookie = re.sub(r"qm_keyst=[^;]*", lambda _match: f"qm_keyst={data['musickey']}", str(cred["cookie"]))
    updated: dict[str, Any] = {"cookie": cookie, "uin": str(data.get("musicid") or uin)}
    if data.get("openid"):
        updated["openId"] = str(data["openid"])
    if data.get("access_token"):
        updated["accessToken"] = str(data["access_token"])
    if data.get("refresh_key"):
        updated["refreshKey"] = str(data["refresh_key"])
    set_credentials("tx", updated)

    try:
        vip_type = await check_vip()
    except Exception:  # noqa: BLE001 - VIP 检测失败不影响续期结果
        vip_type = None
    return {"refreshed": True, **({"vipType": vip_type} if vip_type else {})}


# ---------------- 扫码登录 ----------------


def _int32(value: int) -> int:
    """JS 位运算的 ToInt32 语义。"""
    value &= 0xFFFFFFFF
    return value - 0x100000000 if value >= 0x80000000 else value


def _hash33(text: str) -> int:
    """ptqrtoken：hash33(qrsig)。"""
    hashed = 0
    for char in text:
        shifted = _int32(_int32(hashed) << 5)
        hashed = _int32(hashed + shifted + ord(char))
    return hashed & 0x7FFFFFFF


def _get_gtk(skey: str) -> int:
    """g_tk：p_skey 的 5381 哈希。"""
    hashed = 5381
    for char in skey:
        shifted = _int32(_int32(hashed) << 5)
        hashed = _int32(hashed + shifted + ord(char))
    return hashed & 0x7FFFFFFF


def _random_guid() -> str:
    def repl(match: re.Match[str]) -> str:
        value = int(random.random() * 16) | 0
        if match.group(0) == "y":
            value = (value & 0x3) | 0x8
        return format(value, "X")

    return re.sub(r"[xy]", repl, "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx")


class _CookieJar:
    """登录链路共享的 cookie 罐：同名后到优先，存「name=value」对。"""

    def __init__(self) -> None:
        self._jar: dict[str, str] = {}

    def merge(self, set_cookies: list[str] | None) -> None:
        for item in set_cookies or []:
            pair = str(item).split(";")[0]
            name = pair.split("=")[0].strip() if "=" in pair else ""
            if name:
                self._jar[name] = pair

    def get(self, name: str) -> str:
        pair = self._jar.get(name)
        return "=".join(pair.split("=")[1:]) if pair else ""

    def entries(self) -> list[tuple[str, str]]:
        return list(self._jar.items())

    def header(self) -> str:
        return "; ".join(self._jar.values())


class _PtloginError(RuntimeError):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


async def _ptlogin_request(path: str, query: dict[str, str], cookie: str) -> Any:
    url = f"https://ssl.ptlogin2.qq.com/{path}?{urlencode(query)}"
    kwargs: dict[str, Any] = {"timeout": 15_000}
    if cookie:
        kwargs["headers"] = {"cookie": cookie}
    resp = await http_fetch(url, **kwargs)
    if resp.status_code != 200:
        raise _PtloginError(resp.status_code, f"ptlogin {path} 失败（HTTP {resp.status_code}）")
    return resp


async def qr_show() -> dict[str, Any]:
    """创建扫码登录二维码（客户端扫码后轮询 qr_check），qrsig 需原样回传。"""
    resp = await http_fetch(
        "https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4"
        f"&t={random.random()}&daid=383&pt_3rd_aid=100497308"
        "&u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump",
        timeout=15_000,
    )
    qrsig = ""
    for item in resp.set_cookies:
        match = re.search(r"qrsig=([^;]+)", item)
        if match:
            qrsig = match.group(1)
            break
    if not qrsig:
        raise RuntimeError("获取二维码失败（响应缺少 qrsig）")
    return {"qrimg": f"data:image/png;base64,{base64.b64encode(resp.raw).decode()}", "qrsig": qrsig}


async def qr_check(qrsig: str) -> dict[str, Any]:
    """轮询扫码状态：800 过期 / 801 等待 / 802 已扫码 / 803 成功（凭据已保存）。"""
    if not qrsig:
        raise ApiError(422, "缺少 qrsig")
    jar = _CookieJar()
    jar.merge([f"qrsig={qrsig}"])

    # 1. 轮询扫码状态：0 成功 / 65 已失效 / 66 未扫描 / 67 已扫描 / 68 授权中
    #    qrsig 无效/已被 ptlogin 下线时返回 403，按二维码过期处理
    try:
        poll = await _ptlogin_request(
            "ptqrlogin",
            {
                "u1": "https://graph.qq.com/oauth2.0/login_jump",
                "ptqrtoken": str(_hash33(qrsig)),
                "ptredirect": "0",
                "h": "1",
                "t": "1",
                "g": "1",
                "from_ui": "1",
                "ptlang": "2052",
                "action": f"0-0-{int(time.time() * 1000)}",
                "js_ver": "23111510",
                "js_type": "1",
                "pt_uistyle": "40",
                "aid": "716027609",
                "daid": "383",
                "pt_3rd_aid": "100497308",
                "o1vId": _random_guid(),
            },
            jar.header(),
        )
    except _PtloginError as err:
        if err.status_code == 403:
            return {"code": 800, "message": "二维码已失效"}
        raise
    jar.merge(poll.set_cookies)

    text = poll.body if isinstance(poll.body, str) else ""
    match = re.search(r"ptuiCB\('(\d+)','[^']*','([^']*)'", text)
    state = match.group(1) if match else ""
    if state != "0":
        states = {
            "65": (800, "二维码已失效"),
            "66": (801, "等待扫码"),
            "67": (802, "已扫码，待确认"),
            "68": (802, "授权中"),
        }
        code, message = states.get(state, (801, "等待扫码"))
        return {"code": code, "message": message}

    # 2. check_sig 换 p_skey（g_tk 需要）
    check_sig_url = match.group(2) if match else ""
    if not check_sig_url.startswith("http"):
        raise RuntimeError("登录检查失败（未返回 check_sig 地址）")
    check_sig = await http_fetch(check_sig_url, headers={"cookie": jar.header()}, timeout=15_000)
    jar.merge(check_sig.set_cookies)
    p_skey = jar.get("p_skey")
    if not p_skey:
        raise RuntimeError("登录检查失败（响应缺少 p_skey）")

    # 3. OAuth authorize 换 code（appid 100497308 为 QQ 音乐开放平台）
    authorize = await http_fetch(
        "https://graph.qq.com/oauth2.0/authorize",
        method="POST",
        headers={"Referer": "https://graph.qq.com/oauth2.0/authorize", "cookie": jar.header()},
        form={
            "response_type": "code",
            "client_id": "100497308",
            "redirect_uri": "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/",
            "scope": "get_user_info,get_app_friends",
            "state": "state",
            "switch": "",
            "from_ptlogin": "1",
            "src": "1",
            "update_auth": "1",
            "openapi": "1010_1030",
            "g_tk": str(_get_gtk(p_skey)),
            "auth_time": str(int(time.time() * 1000)),
            "ui": _random_guid(),
        },
        timeout=15_000,
    )
    jar.merge(authorize.set_cookies)
    location = authorize.headers.get("location", "")
    code_match = re.search(r"[?&]code=([^&]+)", location)
    if not code_match:
        raise RuntimeError("OAuth 授权失败（未取得 code）")
    code = code_match.group(1)

    # 4. QQLogin 换凭据：响应体 req.data 携带 musickey/musicid（及 openid 等续期字段）
    login = await http_fetch(
        "https://u.y.qq.com/cgi-bin/musicu.fcg",
        method="POST",
        headers={**HEADERS, "cookie": jar.header()},
        body={
            "comm": {"g_tk": _get_gtk(p_skey), "platform": "yqq", "ct": 24, "cv": 0},
            "req": {"module": "QQConnectLogin.LoginServer", "method": "QQLogin", "param": {"code": code}},
        },
        timeout=15_000,
    )
    jar.merge(login.set_cookies)

    body = as_dict(login.body)
    req = as_dict(body.get("req"))
    data = as_dict(req.get("data"))
    musickey = str(data.get("musickey") or jar.get("qm_keyst") or "")
    if not musickey:
        raise RuntimeError("登录失败（未取得 musickey）")
    # ptlogin 域的 uin 可能带 o 前缀（如 o0123456），统一剥掉
    uin = re.sub(r"^o0*", "", str(data.get("musicid") or jar.get("uin") or "")) or "0"

    # 最终 cookie：uin/qm_keyst 用凭据值放最前，其余链路 cookie 原样保留（排除 ptlogin 域噪声）
    pairs = [f"uin={uin}", f"qm_keyst={musickey}"]
    if data.get("encryptUin"):
        pairs.append(f"euin={data['encryptUin']}")
    skip = {"qrsig", "ptui_loginuin", "uin", "qm_keyst", "euin"}
    for name, pair in jar.entries():
        if name not in skip:
            pairs.append(pair)

    updated: dict[str, Any] = {"cookie": "; ".join(pairs), "uin": uin}
    if data.get("openid"):
        updated["openId"] = str(data["openid"])
    if data.get("access_token"):
        updated["accessToken"] = str(data["access_token"])
    if data.get("refresh_token"):
        updated["refreshToken"] = str(data["refresh_token"])
    if data.get("refresh_key"):
        updated["refreshKey"] = str(data["refresh_key"])
    set_credentials("tx", updated)

    try:
        vip_type = await check_vip()
    except Exception:  # noqa: BLE001 - VIP 检测失败不影响登录结果
        vip_type = None
    return {"code": 803, "message": "登录成功", "uin": uin, **({"vipType": vip_type} if vip_type else {})}
