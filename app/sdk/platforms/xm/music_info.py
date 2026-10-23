"""喜马拉雅曲目信息（对应 sdk/xm/musicInfo.ts，PC 桌面端 baseInfo 通道）。

接口: https://www.ximalaya.com/mobile-playpage/track/v3/baseInfo/{ms_ts}?device=win&trackId=&trackQualityLevel=1

实测（2026-10-02）匿名免费曲目可用，但必须同时满足：
  1) 携带 PC 设备 Cookie（install_id 与 1&_device 同一 uuid，channel=99&100001，客户端 4.0.14 抓包格式）
  2) 携带 du_web_sdk 真实 xm-sign（hdaa 上报取 cadd/sid）
缺 Cookie 或换 device=www2 均返回 ret=1001 系统繁忙。

响应 trackInfo 顶层挂载（playUrlList/title/cover*/duration/isPaid/isAuthorized/isXimiUhqTrack），
playUrlList[].url 为 AES-ECB 加密地址（见 decoder.py）。
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from app.sdk.auth_store import get_credentials
from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict, as_list
from app.sdk.platforms.xm.sign import XM_UA, make_xm_sign

BASE_INFO_URL = "https://www.ximalaya.com/mobile-playpage/track/v3/baseInfo/"

#: 进程级设备标识（install_id 与 1&_device 共用同一 uuid，稳定复用）
DEVICE_UUID = str(uuid.uuid4())
PC_DEVICE_COOKIE = f"install_id={DEVICE_UUID}; channel=99&100001; 1&_device=win32&{DEVICE_UUID}&4.0.14"


def build_request_cookie() -> str:
    """登录态 Cookie（/login/xm 绑定，须含 1&_token）；与 PC 设备 Cookie 合并后上送。"""
    login_cookie = str((get_credentials("xm") or {}).get("cookie") or "")
    return f"{login_cookie}; {PC_DEVICE_COOKIE}" if login_cookie else PC_DEVICE_COOKIE


def cover_url(track_info: Any) -> str | None:
    info = as_dict(track_info)
    path = info.get("coverMiddle") or info.get("coverLarge") or info.get("coverSmall")
    if not path:
        return None
    text = str(path)
    return text if text.startswith("http") else f"https://imagev2.xmcdn.com/{text}"


async def get_track_info(track_id: str, track_quality_level: int = 1) -> dict[str, Any]:
    """拉取曲目播放信息（免登免费曲可用；付费/VIP 曲 ret=1001 或 isAuthorized=false）。"""
    xm_sign = await make_xm_sign()
    resp = await http_fetch(
        f"{BASE_INFO_URL}{int(time.time() * 1000)}?device=win&trackId={track_id}"
        f"&trackQualityLevel={track_quality_level}",
        headers={
            "User-Agent": XM_UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": f"https://www.ximalaya.com/sound/{track_id}",
            "Origin": "https://www.ximalaya.com",
            "Cookie": build_request_cookie(),
            "xm-sign": xm_sign,
        },
        timeout=20_000,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"baseInfo HTTP {resp.status_code}")
    body = as_dict(resp.body)
    ret = body.get("ret")
    if ret != 0:
        # 1001：匿名访问付费内容与风控共用；未登录时优先提示绑定登录
        logged = bool((get_credentials("xm") or {}).get("cookie"))
        if ret == 1001 and not logged:
            raise RuntimeError("该内容需要登录（POST /login/xm 绑定 cookie 后重试）")
        raise RuntimeError(str(body.get("msg") or f"baseInfo ret {ret}"))
    track_info = body.get("trackInfo")
    if track_info is None:
        track_info = as_dict(body.get("data")).get("trackInfo")
    if not isinstance(track_info, dict):
        raise RuntimeError("baseInfo 未返回 trackInfo")
    return track_info


def play_url_list(track_info: dict[str, Any]) -> list[dict[str, Any]]:
    """trackInfo.playUrlList 的安全读取（供取流使用）。"""
    return [item for item in as_list(track_info.get("playUrlList")) if isinstance(item, dict)]
