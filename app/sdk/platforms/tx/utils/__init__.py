"""QQ音乐（tx）工具集 —— 签名通道与 zzc 签名。

源: sdk/tx/utils/index.ts + sdk/tx/utils/crypto.ts
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.tx.utils.crypto import zzc_sign

MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"
# 原 TS 用两条不同 UA：musics.fcg 走客户端 UA，musicu.fcg 走旧 IE UA
UA_CLIENT = "QQMusic 14090508(android 12)"
UA_MUSICU = "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)"


async def sign_request(data: dict[str, Any]) -> Any:
    """musics.fcg 签名通道：sign 由 zzc_sign(JSON 串) 生成。

    签名与实际发送的 body 必须是同一个字符串：http_fetch 对 dict 会自行
    json.dumps（默认分隔符带空格），与这里的紧凑序列化不一致会导致服务端验签失败并回
    code 2000。因此统一序列化一次，并把该字符串原样作为 body 发送（str 走原样发送分支）。
    """
    text = _to_json(data)
    sign = zzc_sign(text)
    return await http_fetch(
        f"https://u.y.qq.com/cgi-bin/musics.fcg?sign={sign}",
        method="post",
        headers={"User-Agent": UA_CLIENT},
        body=text,
    )


async def create_musicu_fetch(data: dict[str, Any], retry_num: int = 0) -> dict[str, Any]:
    """musicu.fcg 通用请求，失败重试 3 次（文案与原文一致：try max num）。

    注意：comm 固定 uin=0，即便已登录也走匿名通道 —— 与原文一致（登录态只影响取流）。
    """
    if retry_num > 2:
        raise RuntimeError("try max num")

    try:
        resp = await http_fetch(
            MUSICU_URL,
            method="post",
            headers={"User-Agent": UA_MUSICU},
            body={"comm": {"uin": 0, "format": "json", "ct": 20, "cv": 1859}, **data},
        )
    except (RuntimeError, OSError, TimeoutError):
        return await create_musicu_fetch(data, retry_num + 1)

    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 0:
        return await create_musicu_fetch(data, retry_num + 1)
    return body


def _to_json(data: Any) -> str:
    import json

    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))
