"""JOOX 取流（对应 sdk/apis/joox.ts）。

链路：GET cache.api.joox.com/openjoox2/v1/track/<songid>?...&secret=<md5>
  → ``play_url_list`` 首个 http 地址（无则 ``refrain_url``）→ 带 vkey/hdnts 的 CDN 直链。

上游 Go 的 api.joox.com/web-fcgi-bin/web_get_songinfo 已 404（2026-10 实测），
故取流改用官网当前使用的 openjoox2 通道（签名细节见 ``platforms/joox/music_info.py``）。

地区/签名参数：country=hk & lang=zh_TW & fs=1（请求完整曲目）& im=0；登录 cookie 的
wmid/session_key 会作为 uid/usk 参与签名（/login/joox 绑定后 VIP 曲目可取完整流）。

实测（游客态）：免费曲目拿到 128k MP3 完整流；VIP 曲目只给 preview/refrain 片段
（``node_is_preview: true``、``error_code: 9009002``），与上游行为一致。

音质档位：游客通道实测只有 128k MP3。JOOX 的 has_hq/has_hifi 标志不代表游客可取，
登录态能否拿到更高档位未验证，故 ``SUPPORT_QUALITYS`` 保守地只声明 128k，不虚报。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.joox.music_info import build_track_url
from app.sdk.platforms.joox.util import JOOX_TIMEOUT, joox_headers, normalize_joox_id

SUPPORT_QUALITYS: list[str] = ["128k"]

#: 本平台实际只能返回这一档；返回值里的 type 用它而不是请求的 quality（与 TS 返回 type: '128k' 一致）
_ACTUAL_QUALITY = "128k"


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """取流：openjoox2 详情 → play_url_list / refrain_url。"""
    song_id = normalize_joox_id(song_info.get("songmid") or song_info.get("id") or song_info.get("songid") or "")
    if not song_id:
        raise RuntimeError("joox 歌曲 id 无效")

    url = build_track_url(song_id, full_song=True)
    res = await http_fetch(url, headers=joox_headers(), timeout=JOOX_TIMEOUT)
    body = res.body
    if res.status_code != 200 or not isinstance(body, dict) or body.get("code"):
        msg = ""
        if isinstance(body, dict):
            msg = str(body.get("msg") or body.get("message") or "")
        raise RuntimeError(f"joox 取流失败：{msg or f'HTTP {res.status_code}'}")

    def clean(value: Any) -> str:
        return str(value if value is not None else "").replace("&amp;", "&")

    urls = body.get("play_url_list")
    play_url = ""
    for item in urls if isinstance(urls, list) else []:
        candidate = clean(item)
        if candidate.startswith("http"):
            play_url = candidate
            break
    if not play_url:
        refrain = clean(body.get("refrain_url"))
        if refrain.startswith("http"):
            play_url = refrain
    if not play_url:
        raise RuntimeError("无可用播放地址（VIP/版权限制或地区不可用）")

    return {"type": _ACTUAL_QUALITY, "url": play_url}
