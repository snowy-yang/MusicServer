"""酷狗歌词（对应 sdk/kg/lyric.ts）。

两步：`lyrics.kugou.com/search` 按歌名+hash+时长找候选 → `lyrics.kugou.com/download`
取回 base64 内容。`fmt=krc` 需走 krc_decode 解密，`fmt=lrc` 直接 base64 解码。
"""

from __future__ import annotations

import base64
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.kg.krc_decode import decode_krc

HEADERS = {
    "KG-RC": "1",
    "KG-THash": "expand_search_manager.cpp:852736169:451",
    "User-Agent": "KuGou2012-9020-ExpandSearchManager",
}


def get_intv(interval: Any) -> int:
    """`mm:ss` → 毫秒（原文把秒当毫秒拼给上游，这里保持一致）。"""
    if not interval:
        return 0
    parts = str(interval).split(":")
    total = 0
    unit = 1
    while parts:
        part = parts.pop()
        try:
            total += int(float(part)) * unit
        except ValueError:
            pass
        unit *= 60
    return int(total)


async def _search_lyric(name: str, hash_value: str, time: Any, try_num: int = 0) -> dict[str, str] | None:
    from app.sdk.platforms.kg.util import encode_uri_component

    url = (
        "http://lyrics.kugou.com/search?ver=1&man=yes&client=pc"
        f"&keyword={encode_uri_component(name)}&hash={hash_value}&timelength={time}&lrctxt=1"
    )
    resp = await http_fetch(url, headers=HEADERS)
    if resp.status_code != 200:
        if try_num > 5:
            raise RuntimeError("歌词获取失败")
        return await _search_lyric(name, hash_value, time, try_num + 1)
    body = resp.body if isinstance(resp.body, dict) else {}
    candidates = body.get("candidates") or []
    if not candidates:
        return None
    info = candidates[0]
    fmt = "krc" if info.get("krctype") == 1 and info.get("contenttype") != 1 else "lrc"
    return {"id": str(info.get("id")), "accessKey": str(info.get("accesskey")), "fmt": fmt}


async def _get_lyric_download(id: str, access_key: str, fmt: str, try_num: int = 0) -> dict[str, str]:
    url = f"http://lyrics.kugou.com/download?ver=1&client=pc&id={id}&accesskey={access_key}&fmt={fmt}&charset=utf8"
    resp = await http_fetch(url, headers=HEADERS)
    if resp.status_code != 200:
        if try_num > 5:
            raise RuntimeError("歌词获取失败")
        # 重试必须回到本方法（搜索接口与下载接口的入参语义不同）
        return await _get_lyric_download(id, access_key, fmt, try_num + 1)
    body = resp.body if isinstance(resp.body, dict) else {}
    content = str(body.get("content") or "")
    match body.get("fmt"):
        case "krc":
            return await decode_krc(content)
        case "lrc":
            return {
                "lyric": base64.b64decode(content).decode("utf-8", errors="replace"),
                "tlyric": "",
                "rlyric": "",
                "yrc": "",
            }
        case _:
            raise RuntimeError(f"未知歌词格式: {body.get('fmt')}")


async def get_lyric(song_info: dict[str, Any]) -> dict[str, str]:
    name = str(song_info.get("name") or "")
    hash_value = str(song_info.get("hash") or song_info.get("songmid") or "")
    time = song_info.get("_interval") or get_intv(song_info.get("interval"))
    result = await _search_lyric(name, hash_value, time)
    if not result:
        raise RuntimeError("Get lyric failed")
    return await _get_lyric_download(result["id"], result["accessKey"], result["fmt"])
