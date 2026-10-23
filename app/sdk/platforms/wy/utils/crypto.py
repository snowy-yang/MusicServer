"""eapi / weapi / linuxapi 加密 —— 移植自 sdk/wy/utils/crypto.ts。

算法与上游 Binaryify/NeteaseCloudMusicApi 的 util/crypto.js 逐字节一致：
  * weapi 两层 AES-128-CBC（内层固定 presetKey，外层随机 secretKey），再用 RSA_NO_PADDING 包 secretKey
  * linuxapi / eapi 走 AES-128-ECB
  * Node 的 createCipheriv 默认 PKCS#7 自动补位，这里手工补齐；ECB 忽略 iv

改这里会让所有 eapi 请求的签名失效，必须与上游保持一致。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Any

from cryptography.hazmat.primitives import padding as _sym_padding
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

IV = b"0102030405060708"
PRESET_KEY = b"0CoJUm6Qyw8W8jud"
LINUXAPI_KEY = b"rFgB&h#%2?^eDg:Q"
EAPI_KEY = b"e82ckenh8dichen8"
BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
PUBLIC_KEY = (
    "-----BEGIN PUBLIC KEY-----\n"
    "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2"
    "KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBG"
    "LbCiK45wIDAQAB\n"
    "-----END PUBLIC KEY-----\n"
)


def _aes_encrypt(data: bytes, key: bytes, iv: bytes = b"") -> bytes:
    """AES 加密；iv 为空走 ECB，否则 CBC。补位方式与 Node 默认一致（PKCS#7）。"""
    padder = _sym_padding.PKCS7(128).padder()
    padded = padder.update(data) + padder.finalize()
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv) if iv else modes.ECB())
    encryptor = cipher.encryptor()
    return encryptor.update(padded) + encryptor.finalize()


def _aes_decrypt(data: bytes, key: bytes) -> bytes:
    cipher = Cipher(algorithms.AES(key), modes.ECB())
    decryptor = cipher.decryptor()
    plain = decryptor.update(data) + decryptor.finalize()
    unpadder = _sym_padding.PKCS7(128).unpadder()
    return unpadder.update(plain) + unpadder.finalize()


def _rsa_encrypt(data: bytes, key: str = PUBLIC_KEY) -> bytes:
    """RSA_NO_PADDING：调用方需自行左补零到模长（Node 版同样是手工 Buffer.alloc 补齐）。

    cryptography 不提供 NoPadding（其 RSA 加密强制 PKCS#1 填充），而网易 weapi 的
    secretKey 必须裸加密才与上游一致，因此这里直接做 c = m^e mod n。
    """
    public_key = serialization.load_pem_public_key(key.encode())
    if not isinstance(public_key, rsa.RSAPublicKey):
        raise RuntimeError("网易云 RSA 公钥解析失败")
    numbers = public_key.public_numbers()
    block_size = public_key.key_size // 8
    if len(data) > block_size:
        raise RuntimeError("网易云 RSA 明文超过模长")
    block = b"\x00" * (block_size - len(data)) + data
    return pow(int.from_bytes(block, "big"), numbers.e, numbers.n).to_bytes(block_size, "big")


def _js_json(data: Any) -> str:
    """对齐 JS 的 JSON.stringify（紧凑、保留非 ASCII）。"""
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def weapi(data: Any) -> dict[str, str]:
    text = _js_json(data)
    # Node 的 randomBytes 是密码学随机，用 os.urandom 对齐；取模 62 后映射到 base62 字符的 ASCII 码
    secret_key = bytes(ord(BASE62[byte % 62]) for byte in os.urandom(16))
    inner = base64.b64encode(_aes_encrypt(text.encode(), PRESET_KEY, IV))
    params = base64.b64encode(_aes_encrypt(inner, secret_key, IV)).decode()
    return {"params": params, "encSecKey": _rsa_encrypt(secret_key[::-1]).hex()}


def linuxapi(data: Any) -> dict[str, str]:
    text = _js_json(data)
    return {"eparams": _aes_encrypt(text.encode(), LINUXAPI_KEY).hex().upper()}


def eapi(url: str, data: Any) -> dict[str, str]:
    text = data if isinstance(data, str) else _js_json(data)
    digest = hashlib.md5(f"nobody{url}use{text}md5forencrypt".encode()).hexdigest()
    raw = f"{url}-36cd479b6b5-{text}-36cd479b6b5-{digest}"
    return {"params": _aes_encrypt(raw.encode(), EAPI_KEY).hex().upper()}


def eapi_decrypt(cipher_buffer: bytes) -> str:
    return _aes_decrypt(cipher_buffer, EAPI_KEY).decode("utf-8", errors="replace")
