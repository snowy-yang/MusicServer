"""网易云链接解析（移植自 sdk/wy/link.ts，上游 music-lib/netease/netease.go 的 parseNeteaseLink）。

支持：
  歌曲     https://music.163.com/#/song?id=29732995   /song?id= / /song/29732995
  专辑     https://music.163.com/#/album?id=32311     /album?id= / /album/32311
  歌单     https://music.163.com/#/playlist?id=7507256008 /playlist?id= / /playlist/<id>/<n>/...
裸数字 id 由各模块自行兜底（上游 Parse 不接受裸 id）。

顺序上依次尝试原链接、path+query、hash 片段 —— 网页版把真实路径放在 # 后面，
因此必须逐候选尝试，只看 pathname 会漏掉 `#/song?id=` 这类主流形态。
"""

from __future__ import annotations

import re
from typing import Any, Literal
from urllib.parse import parse_qs, urljoin, urlparse

NeteaseLinkKind = Literal["song", "album", "playlist"]

BASE = "https://music.163.com/"
_KINDS = ("song", "album", "playlist")
_DIGITS = re.compile(r"^\d+$")


def _is_digits(value: str) -> bool:
    return value != "" and _DIGITS.match(value) is not None


def _parse_candidate(candidate: str) -> tuple[str, str]:
    """解析单个候选串（JS 需给相对候选补 base；Go 的 url.Parse 直接接受相对路径）。"""
    try:
        parsed = urlparse(urljoin(BASE, candidate))
    except ValueError:
        return "", ""

    kind = ""
    segments = [seg for seg in parsed.path.lower().split("/") if seg]
    # 取最后一个出现的类型段：/playlist/xxx 之类多余段不影响判断
    for segment in segments:
        if segment in _KINDS:
            kind = segment

    id_ = parse_qs(parsed.query).get("id", [""])[0]
    if not _is_digits(id_):
        id_ = ""

    if not kind and len(segments) >= 2:
        last, prev = segments[-1], segments[-2]
        if _is_digits(last) and prev in _KINDS:
            kind, id_ = prev, last

    if not kind or not id_:
        return "", ""
    return kind, id_


def parse_netease_link(link: Any) -> tuple[NeteaseLinkKind, str]:
    """链接 → (类型, id)。无法识别时抛 ValueError（文案与原文一致）。"""
    raw = str(link or "").strip()
    candidates = [raw]

    try:
        parsed = urlparse(urljoin(BASE, raw))
    except ValueError:
        parsed = None
    if parsed is not None:
        if parsed.path and parsed.path != "/":
            candidates.append(parsed.path + (f"?{parsed.query}" if parsed.query else ""))
        fragment = re.sub(r"^#!?", "", parsed.fragment).strip()
        if fragment:
            candidates.append(fragment)

    for candidate in candidates:
        kind, id_ = _parse_candidate(candidate)
        if kind and id_:
            return kind, id_  # type: ignore[return-value]
    raise ValueError("无效的网易云链接")


def bare_id(link: Any) -> str:
    """裸 id 兜底：非 URL 且全数字时视为对应类型的 id。"""
    raw = str(link or "").strip()
    return raw if _DIGITS.match(raw) else ""
