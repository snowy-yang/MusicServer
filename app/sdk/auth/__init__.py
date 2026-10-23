"""账号登录模块（对应原 sdk/auth/ 与各平台 login/auth 文件）。

每个模块导出一组 async 函数，路由层只依赖这些签名：

wy：qr_key / qr_check / cellphone_login / login_by_cookie / status
kg：login_by_token / qr_key / qr_check / send_captcha / cellphone_login /
    password_login / verify_user_info / status / refresh_login
tx：qr_show / qr_check / check_vip / refresh_login
lr：login / status
bili：create_qr_login / check_qr_login / status

约定：
  * 成功直接返回 dict（由路由包装成 { code: 0, data }）
  * 可预期的业务失败抛 ApiError(401/422/502, msg)（路由原样转发状态码）
"""

from __future__ import annotations

__all__ = ["bili", "kg", "lr", "tx", "wy"]

from app.sdk.auth import bili, kg, lr, tx, wy
