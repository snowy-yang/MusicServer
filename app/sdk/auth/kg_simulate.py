"""酷狗行为指纹模拟（对应 sdk/auth/kgSimulate.ts）—— sid/edt 生成。

移植自 MakcRe/KuGouMusicApi util/generate_simulate.js，用途：20028 二次验证时替代浏览器 WASM 上报行为数据。

协议：明文 = mid=..;userid=..;dfid=..;webgl=..;webdriver=0;ts=..;data=<事件流>
  * edt = AES-128-CBC(明文, key=md5(rand16)[0:16], iv='kugousecurity123') → Base64
  * sid = RSA-OAEP-SHA256(key) → Base64（公钥取自酷狗 WASM 二进制）
事件流：贝塞尔曲线鼠标轨迹(type 3) + 滚动(type 5) + 窗口(type 6)，条目间以 : 分隔，
每条事件后跟一条哨兵记录（时间差字段替换为接近 0xFFFFFFFF 的随机值）。
"""

from __future__ import annotations

import base64
import math
import random
import time
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from app.sdk.common.utils import to_md5
from app.sdk.platforms.kg.util import pkcs7_pad, random_string

SIM_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoW2+Ylo8ALePSQTP0xBF
lFmEOHvBD9tS+s7DBlfKEu3RzzvZTaX1JtYbX4+AVUqj6ARz8IM+CKByqGFvbHN/
W64XxNI+q7z36ajCL3VTJ2W5G9MCJitc6oGbire4NQfhaEq0nC+hxBWQvCbIFflA
2ItrLUbSU7z1bHA/a+jlQm4OWvY+IKnTryOJTPuT1yNOVjbJ8wBLKy2DgQr9pPqW
PmEQtGpR5IM9V8Kao6PaSdKYOWGbX3i2+RzIKhvZUxxtJwdVbqPlDPlW9h4/xIBc
56Lgvr4aIl8nFtwbj4UJVUTFuGrs0tY9H/tXvZ22dUCKuGxW/gW7ZF+gXz6vHtYa
rQIDAQAB
-----END PUBLIC KEY-----"""
SIM_IV = b"kugousecurity123"


def _ri(low: int, high: int) -> int:
    """JS ``Math.floor(Math.random() * (max - min + 1)) + min``。"""
    return math.floor(random.random() * (high - low + 1)) + low


def _round(value: float) -> int:
    """JS Math.round（.5 向上取整，不是 Python 的银行家舍入）。"""
    return math.floor(value + 0.5)


_sentinel = 0xFFFFFFFF - _ri(0, 20)


def _f3(t: int | str, i: int, x: int, y: int) -> str:
    return f"3,{t},{i},{x},{y}"


def _f5(t: int | str, i: int) -> str:
    return f"5,{t},{i}"


def _f6(t: int | str, i: int, x: int, y: int) -> str:
    return f"6,{t},{i},{x},{y}"


def _bezier_path(sx: float, sy: float, ex: float, ey: float, n: int) -> list[dict[str, float]]:
    """三阶贝塞尔鼠标轨迹：随机控制点 + 起步抖动大、后程收敛。"""
    c1x = sx + (ex - sx) * 0.3 + _ri(-80, 80)
    c1y = sy + (ey - sy) * 0.2 + _ri(-60, 60)
    c2x = sx + (ex - sx) * 0.7 + _ri(-60, 60)
    c2y = sy + (ey - sy) * 0.8 + _ri(-40, 40)
    points: list[dict[str, float]] = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        x = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex
        y = u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey
        jitter = max(0.5, 3 - t * 2.5)
        points.append(
            {
                "x": x + (random.random() - 0.5) * jitter,
                "y": y + (random.random() - 0.5) * jitter,
            }
        )
    return points


def _generate_edt_data(start_x: int, start_y: int, end_x: int, end_y: int, mouse_points: int) -> str:
    entries: list[str] = []
    ts = 0
    ei = 0

    entries.extend([_f5(0, 0), _f5(_sentinel, 0), _f5(0, 0), _f5(_sentinel, 0)])

    ts += _ri(5, 20)
    entries.extend([_f6(ts, ei, 750, 500), _f6(_sentinel, ei, 750, 500)])
    ei += 1

    for _ in range(3):
        ts += _ri(80, 600)
        entries.extend([_f5(ts, ei), _f5(_sentinel, ei)])
        ei += 1

    path = _bezier_path(start_x, start_y, end_x, end_y, mouse_points)
    si = 0
    for i, point in enumerate(path):
        ts += _ri(8, 50)
        rx = _round(point["x"])
        ry = _round(point["y"])
        entries.extend([_f3(ts, si, rx, ry), _f3(_sentinel, si, rx, ry)])
        if i > 0 and i % 12 == 0:
            ts += _ri(20, 60)
            entries.extend([_f5(ts, ei), _f5(_sentinel, ei)])
            ei += 1
        si = (si + 1) % 2

    ts += _ri(5, 30)
    entries.extend(
        [
            _f3(ts, 1, _round(end_x + _ri(-5, 5)), _round(end_y + _ri(-5, 5))),
            _f3(_sentinel, 1, _round(end_x), _round(end_y)),
        ]
    )
    return ":".join(entries)


_public_key = None


def _load_public_key() -> Any:
    global _public_key
    if _public_key is None:
        _public_key = serialization.load_pem_public_key(SIM_PUBLIC_KEY.encode())
    return _public_key


def generate_simulate(mid: str | int, userid: str | int, dfid: str, webgl_hash: str = "") -> dict[str, str]:
    """生成模拟行为指纹（sid/edt），验证接口 /v4/verify_user_info 原样上送。"""
    global _sentinel
    _sentinel = 0xFFFFFFFF - _ri(0, 20)
    key = to_md5(random_string(16))[:16]
    points = _ri(30, 60)
    start_x = _ri(200, 600)
    start_y = _ri(200, 500)
    end_x = _ri(500, 700)
    end_y = _ri(80, 150)
    webgl = webgl_hash or to_md5(random_string(32))
    edt_data = _generate_edt_data(start_x, start_y, end_x, end_y, points)
    plaintext = (
        f"mid={mid or 0};userid={userid or 0};dfid={dfid or 0};webgl={webgl};"
        f"webdriver=0;ts={int(time.time() * 1000)};data={edt_data}"
    )

    cipher = Cipher(algorithms.AES(key.encode()), modes.CBC(SIM_IV))
    encryptor = cipher.encryptor()
    edt = base64.b64encode(encryptor.update(pkcs7_pad(plaintext.encode())) + encryptor.finalize()).decode()
    sid = base64.b64encode(
        _load_public_key().encrypt(
            key.encode(),
            padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
        )
    ).decode()
    return {"edt": edt, "sid": sid}
