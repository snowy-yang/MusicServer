"""酷狗音乐 取流（对应 sdk/apis/kg.ts）。

通道：`https://gateway.kugou.com/v5/url`（x-router: trackercdn.kugou.com，android 签名）。
登录后自动带 token/userid（见 /login/kg）；匿名仅能取部分免费资源，VIP/受限资源返回 status:2。
音质映射：128k→128、320k→320、flac→flac、flac24bit→high。
成功响应播放地址在顶层 url: string[] 与 backupUrl: string[]；旧 data:[{url}] 仅作兼容兜底。
album_audio_id 传 NaN 会被网关拒答，必须归零。

注意：TS 原实现在这里 `getDevice()` + `androidSign`，但那两个函数在 `sdk/auth/kg.ts`，
Python 侧 `app/sdk/auth/kg.py` 仍是 stub（不在本次写入范围），因此设备指纹与签名
改为 `app/sdk/platforms/kg/util.py` 的实现 —— 算法逐字一致，指纹同样落在
`auth.json` 的 `_kg_device`，与登录态共用。
"""

from __future__ import annotations

import hashlib
import math
import time
from typing import Any

from app.sdk.auth_store import get_kg_auth
from app.sdk.common.request import http_fetch
from app.sdk.platforms.kg.util import android_sign, encode_uri_component, get_device

SUPPORT_QUALITYS: list[str] = ["128k", "320k", "flac", "flac24bit"]

SALT_KEY = "57ae12eb6890223e355ccfcb74edf70d"
APPID = 1005
CLIENTVER = 11430

QUALITY_MAP = {"128k": "128", "320k": "320", "flac": "flac", "flac24bit": "high"}

URL_API = "https://gateway.kugou.com/v5/url"


def _num(value: Any) -> int:
    """JS 的 Number() 语义：不可解析或非有限值一律归零（网关拒答 NaN）。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    return int(number) if math.isfinite(number) else 0


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    types = song_info.get("_types") or {}
    quality_info = types.get(quality) if isinstance(types, dict) else None
    hash_value = str((quality_info or {}).get("hash") or song_info.get("hash") or "").lower()
    if not hash_value:
        raise RuntimeError("缺少 hash")

    dev = get_device()
    auth = get_kg_auth()
    userid = _num((auth or {}).get("userid") or 0)

    params: dict[str, Any] = {
        "dfid": dev["dfid"],
        "mid": dev["mid"],
        "uuid": "-",
        "appid": APPID,
        "clientver": CLIENTVER,
        "clienttime": int(time.time()),
        "album_id": _num(song_info.get("albumId")),
        "area_code": 1,
        "hash": hash_value,
        "ssa_flag": "is_fromtrack",
        "version": CLIENTVER,
        "page_id": 151369488,
        "quality": QUALITY_MAP.get(quality, "128"),
        "album_audio_id": _num(song_info.get("songmid")),
        "behavior": "play",
        "pid": 2,
        "cmd": 26,
        "pidversion": 3001,
        "IsFreePart": 0,
        "ppage_id": "463467626,350369493,788954147",
        "cdnBackup": 1,
        "module": "",
    }
    if auth:
        params["token"] = auth["token"]
        params["userid"] = userid
    params["key"] = hashlib.md5(f"{hash_value}{SALT_KEY}{APPID}{dev['mid']}{userid}".encode()).hexdigest()
    params["signature"] = android_sign(params)

    qs = "&".join(f"{key}={encode_uri_component(value)}" for key, value in params.items())
    resp = await http_fetch(
        f"{URL_API}?{qs}",
        method="get",
        headers={
            "dfid": dev["dfid"],
            "mid": dev["mid"],
            "clienttime": str(params["clienttime"]),
            "kg-rc": "1",
            "kg-thash": "5d816a0",
            "kg-rec": "1",
            "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
            "x-router": "trackercdn.kugou.com",
            "User-Agent": "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
        },
        timeout=15000,
    )

    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("status") != 1:
        raise RuntimeError(str(body.get("error") or "获取失败（该资源需要酷狗登录）"))

    candidates: list[Any] = []
    if isinstance(body.get("url"), list):
        candidates.extend(body["url"])
    if isinstance(body.get("backupUrl"), list):
        candidates.extend(body["backupUrl"])
    url = next((str(item) for item in candidates if item), "")
    if not url and isinstance(body.get("data"), list):
        for entry in body["data"]:
            if isinstance(entry, dict) and (entry.get("url") or entry.get("fallback")):
                url = str(entry.get("url") or entry.get("fallback"))
                break
    if not url:
        raise RuntimeError("获取失败（网关未返回播放地址）")
    return {"type": quality, "url": url}
