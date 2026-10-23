"""酷狗登录（对应 sdk/auth/kg.ts）—— token 绑定 / 扫码 / 短信验证码 / 账号密码。

与 MakcRe/KuGouMusicApi 协议对齐：
  * 扫码走 login-user.kugou.com 的 web 签名通道；
  * 短信走 android 签名 + AES/RSA；
  * 账密走 /v9/login_by_pwd，触发 20028 风控时返回验证码挑战（ssa-code 事件 +
    sid/edt 行为指纹，指纹由 kg_simulate.py 服务端生成，无需浏览器 WASM）；
  * token 也可从酷狗 App 抓包获取（login.token）后经 /login/kg 绑定。

设备指纹（guid/mid/dfid）与取流共用 platforms/kg/util.py 的实现（落盘 _kg_device）。
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from app.http.api_error import ApiError
from app.sdk.auth.kg_simulate import generate_simulate
from app.sdk.auth_store import get_credentials, set_credentials
from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict, to_md5
from app.sdk.platforms.kg.util import (
    ANDROID_SALT,
    WEB_SALT,
    android_sign,
    encode_uri_component,
    get_device,
    pkcs7_pad,
    pkcs7_unpad,
    random_string,
)

APPID = 1005
CLIENTVER = 11430
#: 登录专用域按参考实现固定 clientver 20489（qr/短信接口实测通过的版本）
LOGIN_CLIENTVER = 20489
SRC_APPID = 2919
QR_URL_PREFIX = "https://h5.kugou.com/apps/loginQRCode/html/index.html"
PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----"""

#: 固定串派生 token 续期密钥（AES-256-CBC key / iv）
AES_KEY_SEED = "90b8382a1bb4ccdcf063102053fd75b8"
AES_IV = "f063102053fd75b8"

# login_by_pwd 的设备校验常量（与参考实现一致，疑似风控指纹固定值）
PWD_T1 = (
    "562a6f12a6e803453647d16a08f5f0c2ff7eee692cba2ab74cc4c8ab47fc467561a7c6b586ce7dc46a63613b246737c0"
    "3a1dc8f8d162d8ce1d2c71893d19f1d4b797685a4c6d3d81341cbde65e488c4829a9b4d42ef2df470eb102979fa5ad"
    "cdd9b4eecfea8b909ff7599abeb49867640f10c3c70fc444effca9d15db44a9a6c907731e2bb0f22cd9b3536380169"
    "995693e5f0e2424e3378097d3813186e3fe96bbe7023808a0981b4e2b6135a76faac"
)
PWD_T2 = (
    "31c4daf4cf480169ccea1cb7d4a209295865a9d2b788510301694db229b87807469ea0d41b4d4b9173c2151da7294a"
    "eebfc9738df154bbdf11a4e117bb5dff6a3af8ce5ce333e681c1f29a44038f27567d58992eb81283e080778ac77db14"
    "00fdf49b7cf7e26be2e5af4da7830cc3be4"
)
PWD_T3 = "MCwwLDAsMCwwLDAsMCwwLDA="
PWD_CLIENTVER = 11440

VERIFY_VTYPES = {
    16: "QQ 绑定验证",
    18: "微信绑定验证",
    22: "活体认证",
    23: "滑块/图形验证码",
    32: "手机短信验证码",
    34: "人脸核身",
}
VERIFY_URL_TYPES = {
    "KGCodeGT": "极验",
    "KGCodeTX": "腾讯",
    "KGCodeKG": "酷狗旋转",
    "KGCodeKG2": "酷狗滑块",
    "KGCodeSM": "数美",
    "KGCodeYD": "易盾",
}

_ANDROID_UA = "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi"

_public_key = None


def _load_public_key() -> Any:
    global _public_key
    if _public_key is None:
        _public_key = serialization.load_pem_public_key(PUBLIC_KEY.encode())
    return _public_key


def _js_json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _rsa_pkcs1_hex(data: dict[str, Any]) -> str:
    """RSA PKCS#1 v1.5 加密（register_dev 的 p / 登录的 pk 之外的默认形态）。"""
    return _load_public_key().encrypt(_js_json(data).encode(), padding.PKCS1v15()).hex()


def _rsa_no_padding_hex(data: dict[str, Any], *, pad_left: bool) -> str:
    """RSA 裸填充加密（128 字节；verify 左补零，登录/续期右补零，与参考实现一致）。"""
    payload = _js_json(data).encode()
    if len(payload) > 128:
        raise RuntimeError("RSA 负载超长")
    filler = b"\x00" * (128 - len(payload))
    padded = filler + payload if pad_left else payload + filler
    numbers = _load_public_key().public_numbers()
    cipher = pow(int.from_bytes(padded, "big"), numbers.e, numbers.n).to_bytes(128, "big")
    return cipher.hex()


def _aes_cbc_encrypt_hex(data: str, key: str, iv: str) -> str:
    cipher = Cipher(algorithms.AES(key.encode()), modes.CBC(iv.encode()))
    encryptor = cipher.encryptor()
    return (encryptor.update(pkcs7_pad(data.encode())) + encryptor.finalize()).hex()


def _aes_encrypt_random(data: str | dict[str, Any]) -> dict[str, str]:
    """随机密钥 AES-256-CBC：key=md5(rand16)，iv=key[16:32]。"""
    temp_key = random_string(16)
    key_hex = to_md5(temp_key)
    text = data if isinstance(data, str) else _js_json(data)
    return {"str": _aes_cbc_encrypt_hex(text, key_hex, key_hex[16:32]), "key": temp_key}


def _aes_decrypt_hex(hex_text: str, temp_key: str) -> Any:
    key_hex = to_md5(temp_key)
    decryptor = Cipher(algorithms.AES(key_hex.encode()), modes.CBC(key_hex[16:32].encode())).decryptor()
    out = decryptor.update(bytes.fromhex(hex_text)) + decryptor.finalize()
    text = pkcs7_unpad(out).decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


def _playlist_aes_encrypt(data: dict[str, Any]) -> dict[str, str]:
    key = random_string(6)
    key_hex = to_md5(key)
    cipher = Cipher(algorithms.AES(key_hex[:16].encode()), modes.CBC(key_hex[16:32].encode()))
    encryptor = cipher.encryptor()
    payload = encryptor.update(pkcs7_pad(_js_json(data).encode())) + encryptor.finalize()
    return {"key": key, "str": base64.b64encode(payload).decode()}


def _playlist_aes_decrypt(raw_base64: str, key: str) -> Any:
    key_hex = to_md5(key)
    decryptor = Cipher(algorithms.AES(key_hex[:16].encode()), modes.CBC(key_hex[16:32].encode())).decryptor()
    out = decryptor.update(base64.b64decode(raw_base64)) + decryptor.finalize()
    text = pkcs7_unpad(out).decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


def _int_or_zero(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _gateway_headers(params: dict[str, Any], router: str | None, extra: dict[str, str] | None) -> dict[str, str]:
    headers = {
        "dfid": str(params["dfid"]),
        "mid": str(params["mid"]),
        "clienttime": str(params["clienttime"]),
        "kg-rc": "1",
        "kg-thash": "5d816a0",
        "kg-rec": "1",
        "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
        "User-Agent": _ANDROID_UA,
    }
    if router:
        headers["x-router"] = router
    if extra:
        headers.update(extra)
    return headers


async def gateway_request(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    data: Any = None,
    router: str | None = None,
    host: str = "https://gateway.kugou.com",
    headers: dict[str, str] | None = None,
    with_headers: bool = False,
) -> Any:
    """网关移动端签名请求（默认 gateway.kugou.com + x-router，可 host 直连登录专用域）。"""
    dev = get_device()
    all_params: dict[str, Any] = {
        "dfid": dev["dfid"],
        "mid": dev["mid"],
        "uuid": "-",
        "appid": APPID,
        "clientver": CLIENTVER,
        "clienttime": int(time.time()),
    }
    if params:
        all_params.update(params)
    signature = android_sign(all_params, _js_json(data) if data is not None else "")
    query = "&".join(f"{key}={encode_uri_component(value)}" for key, value in all_params.items())
    kwargs: dict[str, Any] = {
        "method": "POST",
        "headers": _gateway_headers(all_params, router, headers),
        "timeout": 15_000,
    }
    if data is not None:
        kwargs["body"] = data
    resp = await http_fetch(f"{host}{url}?{query}&signature={signature}", **kwargs)
    body = as_dict(resp.body)
    if with_headers:
        return body, resp.headers
    return body


def _web_sign(params: dict[str, Any]) -> str:
    items = sorted(f"{key}={value}" for key, value in params.items())
    return to_md5(f"{WEB_SALT}{''.join(items)}{WEB_SALT}")


async def _login_user_get(url: str, extra_params: dict[str, Any] | None = None) -> dict[str, Any]:
    """login-user.kugou.com GET 请求（web 签名，与取流共用同一设备指纹）。"""
    dev = get_device()
    params: dict[str, Any] = {
        "dfid": dev["dfid"],
        "mid": dev["mid"],
        "uuid": "-",
        "appid": APPID,
        "clientver": LOGIN_CLIENTVER,
        "clienttime": int(time.time()),
    }
    if extra_params:
        params.update(extra_params)
    query = "&".join(f"{key}={encode_uri_component(value)}" for key, value in params.items())
    resp = await http_fetch(
        f"https://login-user.kugou.com{url}?{query}&signature={_web_sign(params)}",
        headers=_gateway_headers(params, None, None),
        timeout=15_000,
    )
    body = as_dict(resp.body)
    if body.get("status") != 1:
        raise ApiError(502, str(body.get("error") or "酷狗登录服务请求失败"))
    return body


async def verify_token(token: str, userid: str | int) -> dict[str, Any]:
    """验证 token 并返回账号资料（usercenter /v3/get_my_info，p = RSA 裸填充左补零）。"""
    unix_sec = int(time.time())
    p = _rsa_no_padding_hex({"token": token, "clienttime": unix_sec}, pad_left=True).upper()
    body = await gateway_request(
        "/v3/get_my_info",
        router="usercenter.kugou.com",
        params={"plat": 1},
        data={"visit_time": unix_sec, "usertype": 1, "p": p, "userid": _int_or_zero(userid)},
    )
    data = as_dict(body.get("data"))
    if body.get("status") != 1 or not data:
        raise ApiError(401, str(body.get("error") or "token 无效或已过期"))
    return {
        "userid": data.get("userid") or _int_or_zero(userid),
        "nickname": data.get("nickname") or data.get("username") or None,
        "vip": bool(data["vip"]) if data.get("vip") else None,
    }


async def login_by_token(token: str, userid: str | int) -> dict[str, Any]:
    """绑定并验证 kg token。"""
    profile = await verify_token(token, userid)
    set_credentials("kg", {"token": token, "userid": profile["userid"], "nickname": profile["nickname"]})
    return profile


async def _apply_kg_login(token: str, userid: Any) -> dict[str, Any]:
    """保存登录凭据并拉取账号资料（扫码/短信登录共用；资料校验失败不阻断登录）。"""
    try:
        profile = await verify_token(token, userid)
        set_credentials("kg", {"token": token, "userid": profile["userid"], "nickname": profile["nickname"]})
        return profile
    except Exception:  # noqa: BLE001 - 资料校验失败不影响登录本身
        uid = _int_or_zero(userid)
        set_credentials("kg", {"token": token, "userid": uid})
        return {"userid": uid, "nickname": None, "vip": None}


# ---- 扫码登录 ----


async def qr_key() -> dict[str, Any]:
    """创建扫码登录 key 与二维码（qrimg 为可直接展示的 data URL）。"""
    body = await _login_user_get(
        "/v2/qrcode",
        {
            "appid": 1001,
            "type": 1,
            "plat": 4,
            "qrcode_txt": f"{QR_URL_PREFIX}?appid={APPID}&",
            "srcappid": SRC_APPID,
        },
    )
    data = as_dict(body.get("data"))
    key = data.get("qrcode")
    if not key:
        raise RuntimeError("获取二维码 key 失败")
    qrurl = f"{QR_URL_PREFIX}?qrcode={key}"
    qrimg = str(data.get("qrcode_img") or "")
    if not qrimg:
        from app.sdk.common.qrcode import to_data_url

        try:
            qrimg = to_data_url(qrurl)
        except Exception:  # noqa: BLE001 - 二维码渲染失败不影响 key/url 返回
            qrimg = ""
    return {"key": key, "qrurl": qrurl, "qrimg": qrimg}


async def qr_check(key: str) -> dict[str, Any]:
    """轮询扫码状态（酷狗原生 0/1/2/4 → 800/801/802/803）。"""
    body = await _login_user_get(
        "/v2/get_userinfo_qrcode",
        {"plat": 4, "appid": APPID, "srcappid": SRC_APPID, "qrcode": key},
    )
    data = as_dict(body.get("data"))
    qr_status = data.get("status")
    if qr_status == 4:
        token = data.get("token")
        if not token:
            raise RuntimeError("登录响应中缺少 token")
        return {"code": 803, "message": "登录成功", "profile": await _apply_kg_login(token, data.get("userid"))}
    mapping: dict[Any, tuple[int, str]] = {0: (800, "二维码已过期"), 1: (801, "等待扫码"), 2: (802, "已扫码，待确认")}
    code, message = mapping.get(qr_status, (qr_status, f"未知状态 {qr_status}"))
    return {"code": code, "message": message}


# ---- 手机验证码登录 ----


def _sign_login_key(clienttime_ms: int) -> str:
    return to_md5(f"{APPID}{ANDROID_SALT}{LOGIN_CLIENTVER}{clienttime_ms}")


async def send_captcha(mobile: str) -> dict[str, Any]:
    """发送短信验证码（businessid 5 = 登录场景）。"""
    body = await gateway_request(
        "/v7/send_mobile_code",
        router="login.user.kugou.com",
        params={"clientver": LOGIN_CLIENTVER},
        data={"businessid": 5, "mobile": str(mobile), "plat": 3},
    )
    if body.get("status") != 1:
        raise ApiError(502, str(body.get("error") or body.get("msg") or "验证码发送失败"))
    return {"sent": True}


async def cellphone_login(mobile: str, code: str) -> dict[str, Any]:
    """手机验证码登录（mobile + code，成功后自动保存凭据并返回账号资料）。"""
    clienttime_ms = int(time.time() * 1000)
    enc = _aes_encrypt_random({"mobile": str(mobile), "code": str(code)})
    body = await gateway_request(
        "/v7/login_by_verifycode",
        host="https://loginserviceretry.kugou.com",
        params={"clientver": LOGIN_CLIENTVER},
        data={
            "plat": 1,
            "support_multi": 1,
            "t1": 0,
            "t2": 0,
            "clienttime_ms": clienttime_ms,
            "mobile": f"{str(mobile)[:2]}*****{str(mobile)[10:11]}",
            "key": _sign_login_key(clienttime_ms),
            "pk": _rsa_no_padding_hex({"clienttime_ms": clienttime_ms, "key": enc["key"]}, pad_left=False).upper(),
            "params": enc["str"],
            "t3": "MCwwLDAsMCwwLDAsMCwwLDA=",
        },
        headers={"User-Agent": "Android16-1070-11440-130-0-LOGIN-wifi", "support-calm": "1"},
    )
    if body.get("status") != 1:
        raise ApiError(401, str(body.get("error") or f"登录失败（code {body.get('error_code', '未知')}）"))
    data = as_dict(body.get("data"))
    decrypted = _aes_decrypt_hex(str(data["secu_params"]), enc["key"]) if data.get("secu_params") else None
    token = decrypted.get("token") if isinstance(decrypted, dict) else decrypted
    if not token:
        raise RuntimeError("登录响应解密失败")
    userid = decrypted.get("userid") if isinstance(decrypted, dict) else None
    return await _apply_kg_login(str(token), userid or data.get("userid") or 0)


# ---- token 自动续期 ----


async def refresh_login() -> dict[str, Any]:
    """刷新 kg token（login_by_token），成功后写回凭据存储。"""
    cred = get_credentials("kg") or {}
    if not cred.get("token") or str(cred.get("userid") or "") in ("", "0"):
        return {"skipped": True}

    clienttime = int(time.time())
    p3 = _aes_cbc_encrypt_hex(
        _js_json({"clienttime": clienttime, "token": cred["token"]}), to_md5(AES_KEY_SEED), AES_IV
    )
    enc = _aes_encrypt_random({})
    pk = _rsa_no_padding_hex({"clienttime_ms": clienttime * 1000, "key": enc["key"]}, pad_left=False)

    body = await gateway_request(
        "/v5/login_by_token",
        router="login.user.kugou.com",
        params={"clientver": 20349},
        data={
            "p3": p3,
            "params": enc["str"],
            "userid": _int_or_zero(cred.get("userid")),
            "need_toneinfo": 1,
            "clienttime_ms": clienttime * 1000,
            "dfid": "-",
            "dev": "SDY-AN00",
            "plat": 1,
            "pk": pk,
            "t1": "0",
            "gitversion": "a23c277",
            "t2": "0",
            "t3": "MCwwLDEsMSwwLDYsMSw2LDA=",
        },
        headers={
            "kg-thash": "6a6a1ba",
            "User-Agent": "Android12-AndroidPhone-20349-201-0-ting#958959317/661004247-LOGIN-wifi",
            "support-calm": "1",
        },
    )

    data = as_dict(body.get("data"))
    if body.get("error_code") != 0 or not data.get("secu_params"):
        error = body.get("error")
        raise RuntimeError(f"刷新失败（code {body.get('error_code')}{f': {error}' if error else ''}）")
    decrypted = _aes_decrypt_hex(str(data["secu_params"]), enc["key"])
    if not isinstance(decrypted, dict) or not decrypted.get("token"):
        raise RuntimeError("刷新响应解密失败")
    set_credentials("kg", {"token": decrypted["token"]})
    return {"refreshed": True}


# ---- 设备 dfid 正式注册 ----


async def register_dfid() -> dict[str, Any]:
    """注册正式 dfid（幂等：已注册直接返回；失败抛错由调用方决定是否容忍）。

    随机 dfid 匿名取流易撞 20028 验证；注册后的 dfid 是官方客户端形态，可显著降低风控。
    协议：设备画像 → AES-128-CBC(随机 6 位 key) → base64 作 body；
    p = RSA-PKCS1({aes:key, uid, token})；响应为二进制密文，按 base64 解码后同密钥解密。
    """
    dev = get_device()
    if dev.get("dfidRegistered"):
        return dev

    cred = get_credentials("kg") or {}
    userid = _int_or_zero(cred.get("userid"))
    device_map = {
        "availableRamSize": 4983533568,
        "availableRomSize": 48114719,
        "availableSDSize": 48114717,
        "basebandVer": "",
        "batteryLevel": 100,
        "batteryStatus": 3,
        "brand": "Redmi",
        "buildSerial": "unknown",
        "device": "marble",
        "imei": dev["guid"],
        "imsi": "",
        "manufacturer": "Xiaomi",
        "uuid": dev["guid"],
        "accelerometer": False,
        "accelerometerValue": "",
        "gravity": False,
        "gravityValue": "",
        "gyroscope": False,
        "gyroscopeValue": "",
        "light": False,
        "lightValue": "",
        "magnetic": False,
        "magneticValue": "",
        "orientation": False,
        "orientationValue": "",
        "pressure": False,
        "pressureValue": "",
        "step_counter": False,
        "step_counterValue": "",
        "temperature": False,
        "temperatureValue": "",
    }
    enc = _playlist_aes_encrypt(device_map)
    p = _rsa_pkcs1_hex({"aes": enc["key"], "uid": userid, "token": cred.get("token") or ""})

    params: dict[str, Any] = {
        "dfid": dev["dfid"],
        "mid": dev["mid"],
        "uuid": "-",
        "appid": APPID,
        "clientver": CLIENTVER,
        "clienttime": int(time.time()),
        "part": 1,
        "platid": 1,
        "p": p,
    }
    params["signature"] = android_sign(params, enc["str"])
    query = "&".join(f"{key}={encode_uri_component(value)}" for key, value in params.items())
    resp = await http_fetch(
        f"https://userservice.kugou.com/risk/v2/r_register_dev?{query}",
        method="POST",
        headers={
            "dfid": str(dev["dfid"]),
            "mid": str(dev["mid"]),
            "clienttime": str(params["clienttime"]),
            "User-Agent": _ANDROID_UA,
        },
        body=enc["str"],
        timeout=15_000,
    )

    raw_b64 = (
        base64.b64encode(resp.raw).decode()
        if resp.raw
        else base64.b64encode(_js_json(resp.body or "").encode()).decode()
    )
    body = _playlist_aes_decrypt(raw_b64, enc["key"])
    body = as_dict(body)
    data = as_dict(body.get("data"))
    if body.get("status") != 1 or not data.get("dfid"):
        raise RuntimeError(f"dfid 注册失败（status {body.get('status', '未知')} {body.get('error', '')}）".strip())
    updated = {**dev, "dfid": str(data["dfid"]), "dfidRegistered": True}
    set_credentials("_kg_device", updated)
    return updated


# ---- 账号密码登录 + 20028 验证码挑战 ----


async def get_verify_info(eventid: str) -> dict[str, Any]:
    """查询验证事件详情（/verifyservice/v3/get_verify_info）。"""
    cred = get_credentials("kg") or {}
    body = await gateway_request(
        "/verifyservice/v3/get_verify_info",
        data={
            "eventid": eventid,
            "userid": _int_or_zero(cred.get("userid")),
            "platid": 2,
            "rtype": 1,
            "wasm": 1,
            "i": "",
            "sid": "",
            "edt": "",
        },
    )
    if body.get("status") != 1 and body.get("error_code") != 0:
        raise RuntimeError(str(body.get("error") or f"查询验证信息失败（code {body.get('error_code', '未知')}）"))
    data = body.get("data")
    return data if isinstance(data, dict) else {}


async def verify_user_info(
    eventid: str,
    v_type: int,
    verifycode: str,
    sid: str | None = None,
    edt: str | None = None,
) -> dict[str, Any]:
    """提交验证结果（/v4/verify_user_info，verifycode 为 KGCodeXX|{json} 或短信码）。"""
    dev = get_device()
    cred = get_credentials("kg") or {}
    userid = _int_or_zero(cred.get("userid"))
    fingerprint = {"sid": sid, "edt": edt} if sid and edt else generate_simulate(dev["mid"], userid, dev["dfid"])
    data_map: dict[str, Any] = {
        "eventid": eventid,
        "userid": userid,
        "platid": 2,
        "v_type": _int_or_zero(v_type) or 23,
        "wasm": 1,
        "i": "",
        "sid": fingerprint["sid"],
        "edt": fingerprint["edt"],
    }
    enc = _aes_encrypt_random({"code": verifycode} if data_map["v_type"] == 32 else {})
    if data_map["v_type"] == 32:
        # 手机短信验证码：明文 code + 密文 params 均携带
        data_map.update({"code": verifycode, "verifycode": verifycode})
        data_map["pk"] = _rsa_no_padding_hex({"key": enc["key"]}, pad_left=False)
    else:
        # 滑块等图形验证码：KGCodeXX|{ticket,...} 明文上送
        data_map.update({"verifycode": verifycode})
        data_map["pk"] = _rsa_no_padding_hex({"key": enc["key"]}, pad_left=False)
    data_map["params"] = enc["str"]

    body = await gateway_request(
        "/v4/verify_user_info",
        host="https://verifyservice.kugou.com",
        params={"clientver": 11510},
        data=data_map,
    )
    if body.get("status") != 1:
        raise ApiError(401, str(body.get("error") or f"验证提交失败（code {body.get('error_code', '未知')}）"))
    return {"verified": True}


async def password_login(username: str, password: str, code: str | None = None) -> dict[str, Any]:
    """账号密码登录（/v9/login_by_pwd）；命中 20028 风控返回验证码挑战。"""
    # 账密登录风控最敏感，先确保 dfid 已正式注册（失败容忍，随机 dfid 继续尝试）
    try:
        await register_dfid()
    except Exception:  # noqa: BLE001 - 注册失败不阻断登录
        pass
    clienttime_ms = int(time.time() * 1000)
    enc = _aes_encrypt_random({"pwd": str(password), "code": str(code or ""), "clienttime_ms": clienttime_ms})
    body, headers = await gateway_request(
        "/v9/login_by_pwd",
        router="login.user.kugou.com",
        params={"clientver": PWD_CLIENTVER},
        data={
            "plat": 1,
            "support_multi": 1,
            "clienttime_ms": clienttime_ms,
            "t1": PWD_T1,
            "t2": PWD_T2,
            "t3": PWD_T3,
            "dev": "SDY-AN00",
            "username": str(username),
            "params": enc["str"],
            "pk": _rsa_no_padding_hex({"clienttime_ms": clienttime_ms, "key": enc["key"]}, pad_left=False).upper(),
        },
        headers={"User-Agent": f"Android16-1070-{PWD_CLIENTVER}-130-0-LOGIN-wifi", "support-calm": "1"},
        with_headers=True,
    )

    data = as_dict(body.get("data"))
    if body.get("status") == 1 and data.get("secu_params"):
        decrypted = _aes_decrypt_hex(str(data["secu_params"]), enc["key"])
        token = decrypted.get("token") if isinstance(decrypted, dict) else decrypted
        if not token:
            raise RuntimeError("登录响应解密失败")
        userid = decrypted.get("userid") if isinstance(decrypted, dict) else None
        return await _apply_kg_login(str(token), userid or data.get("userid") or 0)

    if body.get("error_code") == 20028:
        eventid = str(headers.get("ssa-code") or body.get("ssaCode") or "")
        if not eventid:
            raise RuntimeError("触发风控验证但未返回事件 id（ssa-code），请改用扫码或短信登录")
        dev = get_device()
        cred = get_credentials("kg") or {}
        fingerprint = generate_simulate(dev["mid"], _int_or_zero(cred.get("userid")), dev["dfid"])
        try:
            info = await get_verify_info(eventid)
        except Exception:  # noqa: BLE001 - 挑战详情失败时按默认类型返回
            info = {}
        v_type = _int_or_zero(info.get("v_type")) or 23
        url = str(info.get("url") or "")
        provider = next((key for key in VERIFY_URL_TYPES if key in url), "")
        challenge: dict[str, Any] = {
            "eventid": eventid,
            "v_type": v_type,
            "vTypeLabel": VERIFY_VTYPES.get(v_type, f"未知类型 {v_type}"),
            "url": url or None,
            "provider": VERIFY_URL_TYPES[provider] if provider else None,
            "txappid": info.get("txappid"),
            "sessionid": info.get("sessionid"),
            "sid": fingerprint["sid"],
            "edt": fingerprint["edt"],
        }
        return challenge

    raise ApiError(401, str(body.get("error") or f"登录失败（code {body.get('error_code', '未知')}）"))


async def status() -> dict[str, Any] | None:
    """当前 kg 登录资料（未登录返回 None）。"""
    cred = get_credentials("kg") or {}
    if not cred.get("token"):
        return None
    return {"userid": cred.get("userid"), "nickname": cred.get("nickname")}
