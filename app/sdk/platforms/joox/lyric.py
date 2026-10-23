"""JOOX 歌词（对应 sdk/joox/lyric.ts，上游 joox/lyric.go 移植）。

主通道：GET https://api.joox.com/web-fcgi-bin/web_lyric?musicid=<id>&country=sg&lang=zh_cn
  响应形如 ``MusicJsonCallback({"code":0,"lyric":"<base64>"})``，lyric 为 base64 UTF-8 歌词。
  实测（2026-10）：该旧接口仍可用（同域的 web_get_songinfo 已 404，但 web_lyric 未下线）。
兜底：openjoox2 /track 详情的 ``lrc_content``（同为 base64）。
解码：base64 → UTF-8 → HTML 实体（&amp; 等）→ ``{ lyric, tlyric: "" }``。

QRC（``qrc_content``，XML 格式）上游与 TS 均未解析，此处同样不解析，避免引入未验证逻辑。
"""

from __future__ import annotations

import json
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.joox.music_info import build_track_url
from app.sdk.platforms.joox.util import (
    JOOX_TIMEOUT,
    decode_joox_lyric,
    encode_uri_component,
    first_non_empty,
    joox_headers,
    normalize_joox_id,
)

LEGACY_LYRIC_URL = "https://api.joox.com/web-fcgi-bin/web_lyric"


def parse_lyric_payload(body: Any) -> dict[str, Any] | None:
    """解析 MusicJsonCallback(...) / 裸 JSON 包裹。"""
    if isinstance(body, dict):
        return body
    text = str(body if body is not None else "")
    index = text.find("MusicJsonCallback(")
    if index >= 0:
        text = text[index + len("MusicJsonCallback(") :]
        text = text.rstrip()
        if text.endswith(";"):
            text = text[:-1].rstrip()
        if text.endswith(")"):
            text = text[:-1].rstrip()
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def parse_legacy_lyric(status_code: int, body: Any) -> str:
    """上游 GetLyrics 的纯逻辑部分：web_lyric 响应体 → 歌词文本。"""
    if status_code != 200:
        raise RuntimeError(f"joox 歌词获取失败（HTTP {status_code}）")
    payload = parse_lyric_payload(body)
    if not payload:
        raise RuntimeError("joox 歌词解析失败")
    raw = str(first_non_empty(payload.get("lyric"), ""))
    if int(payload.get("code") or 0) != 0 or not raw:
        raise RuntimeError("joox 歌词不存在或为空")
    return decode_joox_lyric(raw)


async def get_legacy_lyric(song_id: str) -> str:
    """上游 GetLyrics 通道（仅旧接口，测试/内部用）。"""
    url = f"{LEGACY_LYRIC_URL}?musicid={encode_uri_component(song_id)}&country=sg&lang=zh_cn"
    res = await http_fetch(url, headers=joox_headers(), timeout=JOOX_TIMEOUT)
    return parse_legacy_lyric(res.status_code, res.body)


async def get_lyric(song_info: dict[str, Any], *_rest: Any) -> dict[str, str]:
    """歌词：旧接口优先，失败回退 openjoox2 详情的 lrc_content。"""
    song_id = normalize_joox_id(song_info.get("songmid") or song_info.get("id") or song_info.get("songid") or "")
    if not song_id:
        raise RuntimeError("joox 歌曲 id 无效")

    # 1) 上游 web_lyric 通道
    legacy_err: Exception | None = None
    try:
        url = f"{LEGACY_LYRIC_URL}?musicid={encode_uri_component(song_id)}&country=sg&lang=zh_cn"
        res = await http_fetch(url, headers=joox_headers(), timeout=JOOX_TIMEOUT)
        return {"lyric": parse_legacy_lyric(res.status_code, res.body), "tlyric": ""}
    except Exception as err:  # noqa: BLE001 - 降级链：任一失败都转 openjoox2 兜底
        legacy_err = err

    # 2) 兜底：openjoox2 详情 lrc_content（base64）
    res = await http_fetch(build_track_url(song_id), headers=joox_headers(), timeout=JOOX_TIMEOUT)
    body = res.body if isinstance(res.body, dict) else {}
    raw = str(first_non_empty(body.get("lrc_content"), ""))
    if res.status_code != 200 or not raw:
        raise legacy_err or RuntimeError("joox 歌词不存在或为空")
    return {"lyric": decode_joox_lyric(raw), "tlyric": ""}
