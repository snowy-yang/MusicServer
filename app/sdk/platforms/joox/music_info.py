"""JOOX 歌曲详情 / 取流通道（openjoox2 v1，web 播放器同款签名接口）。

对应 sdk/joox/musicInfo.ts。

端点：GET https://cache.api.joox.com/openjoox2/v1/track/<id>
      ?country=hk&lang=zh_TW&lyric=1&fs=<0|1>&im=<0|1>[&uid=<wmid>][&usk=<session_key>]&secret=<md5>

签名：secret = md5('Jo0x@t3Nc3nT' + 'country=..&lang=..&lyric=1&fs=..&im=..[&uid=..][&usk=..]&id=..')
  * 参数按**插入序**参与签名；id 用 '/' → '_' 替换后的值，且发布 URL 前会从 query 中删除 id。
  * 签名串与真正发出的参数来自同一次序列化（同一份 params dict + 同一 encoder），不做二次拼接。
  * 实测（2026-10）：不带/带错 secret → 401 {"code":-10005,"msg":"Invalid secret key"}；
    按上式 → 200，返回 play_url_list / refrain_url / lrc_content / qrc_content / vip_flag 等。

上游 Go 的 api.joox.com/web-fcgi-bin/web_get_songinfo 已 404（2026-10 前），本模块为其替代。
``fs=1`` 请求完整曲目（游客仍可能拿到 preview/refrain），``im`` 为 mobile 标记。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.joox.util import (
    JOOX_TIMEOUT,
    cookie_value,
    encode_uri_component,
    joox_headers,
    joox_login_cookie,
    joox_sign,
    normalize_joox_id,
    normalize_joox_lang,
)

JOOX_OPENJOOX2 = "https://cache.api.joox.com/openjoox2/v1"


def build_track_url(
    raw_id: Any,
    country: str = "",
    lang: str = "",
    full_song: bool = False,
    is_mobile: bool = False,
) -> str:
    """构造 openjoox2 歌曲详情 URL（含签名；登录态自动带 uid/usk）。"""
    track_id = str(normalize_joox_id(raw_id)).replace("/", "_")
    params: dict[str, Any] = {
        "country": country or "hk",
        "lang": normalize_joox_lang(lang or "zh_TW"),
        "lyric": 1,
        "fs": 1 if full_song else 0,
        "im": 1 if is_mobile else 0,
    }
    # 仅绑定登录凭据后才带 uid/usk（游客态与官网播放器一致，不带这两项）
    login_cookie = joox_login_cookie()
    uid = cookie_value(login_cookie, "wmid") if login_cookie else ""
    usk = cookie_value(login_cookie, "session_key") if login_cookie else ""
    if uid:
        params["uid"] = uid
    if usk:
        params["usk"] = usk
    # 签名时包含 id（与 web 播放器一致），发布 query 时 id 走路径、不进 query
    secret = joox_sign({**params, "id": track_id})
    query = "&".join(f"{key}={encode_uri_component(value)}" for key, value in {**params, "secret": secret}.items())
    return f"{JOOX_OPENJOOX2}/track/{track_id}?{query}"


async def get_track_detail(
    raw_id: Any,
    country: str = "",
    lang: str = "",
    full_song: bool = False,
    is_mobile: bool = False,
) -> dict[str, Any]:
    """歌曲详情（openjoox2；上游 fetchSongInfo 的替代实现）。"""
    track_id = normalize_joox_id(raw_id)
    if not track_id:
        raise RuntimeError("joox 歌曲 id 无效")
    url = build_track_url(track_id.replace("/", "_"), country, lang, full_song, is_mobile)
    res = await http_fetch(url, headers=joox_headers(), timeout=JOOX_TIMEOUT)
    body = res.body
    if res.status_code != 200 or not isinstance(body, dict) or body.get("code"):
        msg = ""
        if isinstance(body, dict):
            msg = str(body.get("msg") or body.get("message") or "")
        raise RuntimeError(f"joox 歌曲详情获取失败：{msg or f'HTTP {res.status_code}'}")
    return body


def pick_track_url(detail: Any) -> str:
    """从详情里挑选可播放地址：play_url_list 优先，refrain_url 兜底；并还原 &amp; 实体。"""
    if not isinstance(detail, dict):
        return ""

    def clean(value: Any) -> str:
        return str(value if value is not None else "").replace("&amp;", "&")

    urls = detail.get("play_url_list")
    for url in urls if isinstance(urls, list) else []:
        text = clean(url)
        if text.startswith("http"):
            return text
    refrain = clean(detail.get("refrain_url"))
    return refrain if refrain.startswith("http") else ""
