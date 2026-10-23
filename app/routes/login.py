"""登录路由 —— wy 扫码/手机号/cookie，kg 扫码/短信/密码/token，tx 扫码/cookie，
xm/me cookie，lr 账密，bili 扫码；凭据持久化于 data/auth.json。

成功返回 `ok(data)`（{ code: 0, data }）；可预期失败抛 ApiError，其它异常按 502 上报
（与原实现 `fail(reply, err)` 的 `err.status ?? 502` 一致）。
"""

from __future__ import annotations

from typing import Any

from app.http.api_error import ApiError, upstream
from app.http.envelope import ok
from app.routes.refresh import refresh_all
from app.sdk import auth as auth_mod
from app.sdk.auth_store import clear_credentials, get_credentials, get_tx_auth, set_credentials
from fastapi import APIRouter, Body

router = APIRouter()

LOGIN_TAG = "登录"


async def _call(fn: Any, *args: Any, **kwargs: Any) -> Any:
    """调用平台登录实现并包成信封；ApiError 原样抛（保留状态码），其余转 502。"""
    try:
        return ok(await fn(*args, **kwargs))
    except ApiError:
        raise
    except NotImplementedError as err:
        raise ApiError(501, f"该登录方式尚未移植：{err}") from err
    except Exception as err:
        raise upstream(str(err)) from err


def _body(description: str) -> Any:
    # embed=True：与 TS 契约一致，所有登录接口都以 JSON 对象传参（{"key": ...}），
    # 而不是把单个参数当成裸 JSON 值。多参数时 FastAPI 本就自动嵌套，行为不变。
    return Body(..., embed=True, description=description)


# ---------- 网易云 ----------


@router.post(
    "/login/wy/qr",
    tags=[LOGIN_TAG],
    summary="获取网易云扫码登录二维码",
    description="用网易云 App 扫码后轮询 /login/wy/qr/check 完成登录。返回 qrimg（data URL）可直接展示。",
)
async def wy_qr() -> Any:
    return await _call(auth_mod.wy.qr_key)


@router.post(
    "/login/wy/qr/check",
    tags=[LOGIN_TAG],
    summary="轮询网易云扫码状态",
    description="code：800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功（自动保存凭据并返回账号资料）。",
)
async def wy_qr_check(key: str = _body("qrKey 返回的 key")) -> Any:
    return await _call(auth_mod.wy.qr_check, key)


@router.post(
    "/login/wy/cellphone",
    tags=[LOGIN_TAG],
    summary="网易云手机号登录",
    description="password（明文，服务端 MD5 后提交）与 captcha（短信验证码）二选一。",
)
async def wy_cellphone(
    phone: str = _body("手机号"),
    password: str | None = Body(None, description="明文密码"),
    captcha: str | None = Body(None, description="短信验证码"),
    countrycode: str = Body("86", description="国家码"),
) -> Any:
    return await _call(auth_mod.wy.cellphone_login, phone, password, captcha, countrycode)


@router.post(
    "/login/wy",
    tags=[LOGIN_TAG],
    summary="绑定网易云 cookie",
    description="cookie 从已登录的 music.163.com 浏览器请求头复制（须含 MUSIC_U 字段）。"
    "绑定前服务端实测校验有效性（account/get），失效返回 401。无法自动续期，失效后需重新复制绑定。",
)
async def wy_bind(cookie: str = _body("浏览器 cookie")) -> Any:
    return await _call(auth_mod.wy.login_by_cookie, cookie)


@router.delete("/login/wy", tags=[LOGIN_TAG], summary="退出网易云登录")
async def wy_logout() -> Any:
    clear_credentials("wy")
    return ok({"logged": False})


# ---------- 酷狗 ----------


@router.post(
    "/login/kg",
    tags=[LOGIN_TAG],
    summary="绑定酷狗 token",
    description="token 从酷狗 App 抓包获取（login.token），服务端向用户中心验证后存储。"
    "推荐改用 /login/kg/qr 扫码或 /login/kg/cellphone 短信验证码登录，无需抓包。",
)
async def kg_bind(token: str = _body("酷狗 token"), userid: str | int = _body("酷狗 userid")) -> Any:
    return await _call(auth_mod.kg.login_by_token, token, userid)


@router.post("/login/kg/qr", tags=[LOGIN_TAG], summary="获取酷狗扫码登录二维码")
async def kg_qr() -> Any:
    return await _call(auth_mod.kg.qr_key)


@router.post("/login/kg/qr/check", tags=[LOGIN_TAG], summary="轮询酷狗扫码状态")
async def kg_qr_check(key: str = _body("qrKey 返回的 key")) -> Any:
    return await _call(auth_mod.kg.qr_check, key)


@router.post(
    "/login/kg/captcha",
    tags=[LOGIN_TAG],
    summary="发送酷狗短信验证码",
    description="向手机号发送登录验证码（有频控，勿频繁调用），随后用 /login/kg/cellphone 提交。",
)
async def kg_captcha(mobile: str = _body("手机号")) -> Any:
    return await _call(auth_mod.kg.send_captcha, mobile)


@router.post("/login/kg/cellphone", tags=[LOGIN_TAG], summary="酷狗手机验证码登录")
async def kg_cellphone(mobile: str = _body("手机号"), code: str = _body("短信验证码")) -> Any:
    return await _call(auth_mod.kg.cellphone_login, mobile, code)


@router.post(
    "/login/kg/password",
    tags=[LOGIN_TAG],
    summary="酷狗账号密码登录",
    description="触发 20028 风控时返回 needVerify 挑战（含 eventid、验证类型与 sid/edt 指纹）："
    "滑块类需浏览器完成图形验证后调 /login/kg/verify 再重试；短信类（v_type=32）先提交短信码再带 code 重试。",
)
async def kg_password(
    username: str = _body("账号"),
    password: str = _body("密码"),
    code: str | None = Body(None, description="短信验证码（20028 短信验证通过后重试登录时携带）"),
) -> Any:
    return await _call(auth_mod.kg.password_login, username, password, code)


@router.post("/login/kg/verify", tags=[LOGIN_TAG], summary="提交酷狗风控验证结果")
async def kg_verify(
    eventid: str = _body("needVerify 返回的 eventid"),
    v_type: int = _body("验证类型（needVerify 返回的 v_type）"),
    verifycode: str = _body("图形验证码凭证或短信验证码"),
    sid: str | None = Body(None, description="行为指纹 sid（省略时服务端生成）"),
    edt: str | None = Body(None, description="行为指纹 edt（省略时服务端生成）"),
) -> Any:
    return await _call(auth_mod.kg.verify_user_info, eventid, v_type, verifycode, sid, edt)


@router.delete("/login/kg", tags=[LOGIN_TAG], summary="退出酷狗登录")
async def kg_logout() -> Any:
    clear_credentials("kg")
    return ok({"logged": False})


# ---------- QQ 音乐 ----------


@router.post(
    "/login/tx/qr",
    tags=[LOGIN_TAG],
    summary="获取 QQ 音乐扫码登录二维码",
    description="返回 qrimg（data URL）可直接展示，qrsig 需原样回传。",
)
async def tx_qr() -> Any:
    return await _call(auth_mod.tx.qr_show)


@router.post("/login/tx/qr/check", tags=[LOGIN_TAG], summary="轮询 QQ 音乐扫码状态")
async def tx_qr_check(qrsig: str = _body("qrShow 返回的 qrsig")) -> Any:
    return await _call(auth_mod.tx.qr_check, qrsig)


@router.post(
    "/login/tx",
    tags=[LOGIN_TAG],
    summary="绑定 QQ 音乐 cookie",
    description="cookie 从已登录的 y.qq.com 浏览器请求头复制（需含 uin 与 qm_keyst 字段），"
    "用于解锁 tx 取流的 320k/无损音质。",
)
async def tx_bind(
    cookie: str = _body("浏览器 cookie"),
    openId: str | None = Body(None, description="App 抓包的 openId（用于自动续期）"),
    accessToken: str | None = Body(None, description="App 抓包的 accessToken"),
    refreshToken: str | None = Body(None, description="App 抓包的 refreshToken"),
    refreshKey: str | None = Body(None, description="App 抓包的 refreshKey"),
) -> Any:
    import re

    match = re.search(r"uin=(\d+)", cookie)
    if not match or not re.search(r"qm_keyst=\S+", cookie):
        raise ApiError(422, "cookie 需包含 uin 与 qm_keyst 字段")
    uin = match.group(1)
    set_credentials(
        "tx",
        {
            "cookie": cookie,
            "uin": uin,
            "openId": openId,
            "accessToken": accessToken,
            "refreshToken": refreshToken,
            "refreshKey": refreshKey,
        },
    )
    return ok({"logged": True, "uin": uin})


@router.delete("/login/tx", tags=[LOGIN_TAG], summary="退出 QQ 音乐登录")
async def tx_logout() -> Any:
    clear_credentials("tx")
    return ok({"logged": False})


# ---------- 喜马拉雅 / 猫耳 / 懒人听书 ----------


@router.post(
    "/login/xm",
    tags=[LOGIN_TAG],
    summary="绑定喜马拉雅 cookie",
    description="cookie 从已登录的 www.ximalaya.com 浏览器请求头复制（须含 1&_token 字段）。",
)
async def xm_bind(cookie: str = _body("浏览器 cookie")) -> Any:
    import re

    if not re.search(r"1&_token=\S+", cookie):
        raise ApiError(422, "cookie 需包含 1&_token 字段")
    set_credentials("xm", {"cookie": cookie})
    return ok({"logged": True})


@router.delete("/login/xm", tags=[LOGIN_TAG], summary="退出喜马拉雅登录")
async def xm_logout() -> Any:
    clear_credentials("xm")
    return ok({"logged": False})


@router.post(
    "/login/me",
    tags=[LOGIN_TAG],
    summary="绑定猫耳FM token",
    description="cookie 从已登录的 m.missevan.com 浏览器请求头或猫耳 App 抓包复制（须含 token= 字段）。",
)
async def me_bind(cookie: str = _body("浏览器 cookie")) -> Any:
    import re

    if not re.search(r"(?:^|;\s*)token=\S+", cookie):
        raise ApiError(422, "cookie 需包含 token 字段")
    set_credentials("me", {"cookie": cookie})
    return ok({"logged": True})


@router.delete("/login/me", tags=[LOGIN_TAG], summary="退出猫耳FM登录")
async def me_logout() -> Any:
    clear_credentials("me")
    return ok({"logged": False})


@router.post(
    "/login/lr",
    tags=[LOGIN_TAG],
    summary="懒人听书账号登录",
    description="m.lrts.me 账号密码登录（密码按上游要求以 base64 提交）。成功后会话 Cookie 持久化，"
    "此后 lr 取流自动携带 —— 懒人听书要求登录态，免费章节同样如此。",
)
async def lr_login(
    account: str = _body("账号（手机号）"), password: str = _body("密码（明文传入，服务端自行编码）")
) -> Any:
    return await _call(auth_mod.lr.login, account, password)


@router.delete("/login/lr", tags=[LOGIN_TAG], summary="退出懒人听书登录")
async def lr_logout() -> Any:
    clear_credentials("lr")
    return ok({"logged": False})


# ---------- 哔哩哔哩 ----------


@router.post(
    "/login/bili/qr",
    tags=[LOGIN_TAG],
    summary="获取哔哩哔哩扫码登录二维码",
    description="用 B站 App 扫码后轮询 /login/bili/qr/check 完成登录。返回 key 需原样回传，qrimg 为 data URL。",
)
async def bili_qr() -> Any:
    return await _call(auth_mod.bili.create_qr_login)


@router.post(
    "/login/bili/qr/check",
    tags=[LOGIN_TAG],
    summary="轮询哔哩哔哩扫码状态",
    description="status：waiting / scanned / success（自动保存凭据）/ expired / failed。"
    "code 为映射后的状态码：800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 登录成功（与其它平台一致）。",
)
async def bili_qr_check(key: str = _body("createQRLogin 返回的 key")) -> Any:
    return await _call(auth_mod.bili.check_qr_login, key)


@router.delete("/login/bili", tags=[LOGIN_TAG], summary="退出哔哩哔哩登录")
async def bili_logout() -> Any:
    clear_credentials("bili")
    return ok({"logged": False})


# ---------- 通用 ----------


@router.post(
    "/login/refresh",
    tags=[LOGIN_TAG],
    summary="手动触发登录态续期",
    description="对已登录的 kg/tx 执行 token/cookie 续期（与自动任务同一逻辑）。"
    "未登录的平台跳过；失败的平台在对应字段返回 error，不影响其他平台。",
)
async def login_refresh() -> Any:
    return ok(await refresh_all())


def _stored_status(package: str) -> dict[str, Any]:
    """按已存凭据判断登录态（xm/me/bd/joox/apple/5sing 用）。"""
    cred = get_credentials(package)
    if not cred:
        return {"logged": False}
    return {"logged": True, "updatedAt": cred.get("updatedAt")}


@router.get(
    "/login/status",
    tags=[LOGIN_TAG],
    summary="查看登录状态",
    description="wy 为实时校验（未登录或 cookie 失效返回 logged: false），kg/tx/bili 为已存凭据"
    "（含 VIP 等级与最近更新时间），xm/me/lr/bd/joox/apple/5sing 为已存凭据。",
)
async def login_status() -> Any:

    async def safe_wy() -> dict[str, Any]:
        try:
            result = await auth_mod.wy.status()
            return {"logged": True, **result} if result else {"logged": False}
        except Exception:  # noqa: BLE001 - 未登录/失效都按未登录处理
            return {"logged": False}

    async def safe_kg() -> dict[str, Any]:
        cred = get_credentials("kg")
        if not cred or not cred.get("token"):
            return {"logged": False}
        try:
            result = await auth_mod.kg.status()
        except Exception:  # noqa: BLE001 - 未登录/失效都按未登录处理
            result = None
        payload = {**(result or {}), "updatedAt": cred.get("updatedAt")}
        return {"logged": True, **payload}

    wy_result = await safe_wy()
    tx = get_tx_auth()
    tx_cred = get_credentials("tx") or {}
    return ok(
        {
            "wy": wy_result,
            "kg": await safe_kg(),
            "tx": (
                {
                    "logged": True,
                    "uin": tx["uin"],
                    "vipType": tx_cred.get("vipType", None),
                    "updatedAt": tx_cred.get("updatedAt"),
                }
                if tx
                else {"logged": False}
            ),
            "xm": _stored_status("xm"),
            "me": _stored_status("me"),
            "lr": _stored_status("lr"),
            "bili": _stored_status("bili"),
            "bd": _stored_status("bd"),
            "joox": _stored_status("joox"),
            "apple": _stored_status("apple"),
            "5sing": _stored_status("5sing"),
        }
    )
