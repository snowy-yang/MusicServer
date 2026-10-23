"""JOOX 平台公共工具：请求头/签名/ID 归一化/链接构造/页面数据提取（对应 sdk/joox/util.ts）。

背景（与 TS 注释一致，2026-10 实测）：
  * JOOX 是东南亚服务，www.joox.com 会按来源 IP 返回「Sorry, JOOX is not available in this
    location」；上游通过伪造 ``X-Forwarded-For`` 为东南亚 IP（36.73.34.109）绕过，本移植保持一致。
  * 新版 web 播放器走 ``cache.api.joox.com/openjoox2/v1/*``，**必须**带 secret 签名：
        secret = md5('Jo0x@t3Nc3nT' + 参数按插入序 k=v&... )（值经 encodeURIComponent）
    密钥来自官网 JS bundle 常量 secretAPIKey（web 公开常量，非账号密钥）。
    实测：不带/带错 secret → 401 {"code":-10005,"msg":"Invalid secret key"}；按上式 → 200。
  * 旧接口 api.joox.com/web-fcgi-bin/web_get_songinfo 已 404（取流/歌曲详情改用 openjoox2），
    但 web_lyric 仍可用（歌词首选通道）。
  * 登录 cookie 里的 wmid/session_key 在签名参数里作为 uid/usk 参与（VIP 完整曲目依赖它）。
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any
from urllib.parse import quote, unquote, urljoin

from app.sdk.auth_store import get_credentials
from app.sdk.common.request import http_fetch

JOOX_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
)
"""上游 Go 的默认游客 Cookie（jaox.go 常量 Cookie）。"""
JOOX_DEFAULT_COOKIE = "wmid=142420656; user_type=1; country=id; session_key=2a5d97d05dc8fe238150184eaf3519ad;"
"""上游 Go 的 X-Forwarded-For（东南亚 IP，绕过地区拦截）。"""
JOOX_XFF = "36.73.34.109"
"""openjoox2 签名密钥（官网 web bundle 常量 secretAPIKey）。"""
JOOX_SECRET_KEY = "Jo0x@t3Nc3nT"
"""平台统一超时（毫秒），与 TS 各处 timeout: 20000 一致。"""
JOOX_TIMEOUT = 20000


def md5_hex(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def encode_uri_component(value: Any) -> str:
    """对齐 JS 的 encodeURIComponent（不编码 !'()*，Python 的 quote 会编码它们）。"""
    return quote(str(value), safe="!~*'()")


def joox_sign(params: dict[str, Any]) -> str:
    """openjoox2 签名：md5(secretAPIKey + `k=encodeURIComponent(v)` 按插入序以 & 连接)。

    **键序即 dict 插入序**（服务端按同序校验），不要重排参数 —— 任何 sorted() 都会破坏签名。
    """
    pairs = [f"{key}={encode_uri_component(value)}" for key, value in params.items()]
    return md5_hex(JOOX_SECRET_KEY + "&".join(pairs))


def joox_login_cookie() -> str:
    """绑定到 auth_store 的登录 cookie（未登录返回空串，不回退游客 cookie）。"""
    cred = get_credentials("joox")
    if not cred:
        return ""
    return str(cred.get("cookie") or "")


def joox_cookie() -> str:
    """请求用 cookie（登录态优先；未登录回退上游游客 cookie）。"""
    return joox_login_cookie() or JOOX_DEFAULT_COOKIE


def cookie_value(cookie: str, name: str) -> str:
    """从 cookie 串里取一个字段。"""
    match = re.search(rf"(?:^|;\s*){re.escape(name)}=([^;]*)", str(cookie or ""))
    return match.group(1).strip() if match else ""


def joox_headers(extra: dict[str, Any] | None = None) -> dict[str, str]:
    """平台公共请求头（含地区伪装与 Cookie）。"""
    headers = {
        "User-Agent": JOOX_UA,
        "Cookie": joox_cookie(),
        "X-Forwarded-For": JOOX_XFF,
        "Referer": "https://www.joox.com/",
        "Accept": "application/json, text/plain, */*",
    }
    if extra:
        headers.update({str(key): str(value) for key, value in extra.items()})
    return headers


def normalize_joox_lang(lang: str | None) -> str:
    """语言归一（对齐官网 51bm.c：zh_hk/zh_mo → zh_TW，zh_cn → zh_CN）。"""
    if lang in ("zh_hk", "zh_mo"):
        return "zh_TW"
    if lang == "zh_cn":
        return "zh_CN"
    return lang or "zh_TW"


def normalize_joox_id(raw: Any) -> str:
    """ID 归一化（上游 normalizeJooxID）：去空白 + 百分号解码（空格还原为 +）。"""
    normalized = str(raw if raw is not None else "").strip()
    if not normalized:
        return ""
    if "%" in normalized:
        try:
            normalized = unquote(normalized, errors="strict")
        except (UnicodeDecodeError, ValueError):
            # 上游 PathUnescape/QueryUnescape 失败时保留原值
            pass
        normalized = normalized.replace(" ", "+")
    return normalized


def joox_song_link(raw_id: Any) -> str:
    return f"https://www.joox.com/hk/single/{normalize_joox_id(raw_id)}"


def joox_album_link(raw_id: Any) -> str:
    return f"https://www.joox.com/hk/album/{normalize_joox_id(raw_id)}"


def joox_regional_playlist_link(region: str, raw_id: Any) -> str:
    return f"https://www.joox.com/{region}/playlist/{normalize_joox_id(raw_id)}"


def joox_playlist_link(raw_id: Any) -> str:
    return joox_regional_playlist_link("id", raw_id)


def joox_playlist_links(raw_id: Any) -> list[str]:
    """歌单页候选（上游顺序：id → sg → hk，逐个尝试直到页面数据可用）。"""
    return [joox_regional_playlist_link(region, raw_id) for region in ("id", "sg", "hk")]


def pick_joox_image(images: Any) -> str:
    """封面挑选（上游 pickJooxImage：优先 300 → 1000 → 100，再回退首个非空）。"""
    items = images if isinstance(images, list) else []
    for width in (300, 1000, 100):
        for image in items:
            if not isinstance(image, dict):
                continue
            url = str(image.get("url") or "").strip()
            if to_int(image.get("width")) == width and url:
                return url
    for image in items:
        if not isinstance(image, dict):
            continue
        url = str(image.get("url") or "").strip()
        if url:
            return url
    return ""


def joox_artists(items: Any) -> str:
    """歌手拼接（上游 joinJooxArtists，分隔符 ' / '）。"""
    listing = items if isinstance(items, list) else []
    names = [str(entry.get("name") or "").strip() for entry in listing if isinstance(entry, dict)]
    return " / ".join(name for name in names if name)


def first_non_empty(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if str(value).strip() != "":
            return value
    return ""


def first_non_zero(*values: Any) -> int | float:
    for value in values:
        number = to_number(value)
        if number is not None and number > 0:
            return number
    return 0


def to_number(value: Any) -> float | None:
    """对齐 JS Number()：有限数值返回 float，其余返回 None。"""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        try:
            number = float(text)
        except ValueError:
            return None
    else:
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def to_int(value: Any) -> int | None:
    number = to_number(value)
    return None if number is None else int(number)


def decode_joox_base64_text(value: Any) -> str:
    """base64 文本解码（上游 decodeJooxBase64Text：容忍 URL-safe 与缺失填充）。"""
    raw = str(value if value is not None else "").strip()
    if not raw:
        return ""
    normalized = raw.replace("-", "+").replace("_", "/")
    padded = normalized + "=" * ((4 - len(normalized) % 4) % 4)
    try:
        text = base64.b64decode(padded, validate=False).decode("utf-8", errors="replace")
    except (ValueError, TypeError):
        return raw
    # 解码结果是二进制噪声时回退原值（对齐上游 stdout base64 校验语义）
    return raw if "\ufffd" in text else text.strip()


def decode_html_entities(text: Any) -> str:
    """HTML 实体解码（歌词文本兜底）。"""
    return (
        str(text if text is not None else "")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
        .replace("&#0*39;", "'")
        .replace("&nbsp;", " ")
    )


def decode_joox_lyric(value: Any) -> str:
    """歌词解码：base64 → utf8 → HTML 实体（上游 base64 + 常见实体兜底）。"""
    return decode_html_entities(decode_joox_base64_text(value))


_NEXT_DATA_RE = re.compile(r'<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)</script>')


def extract_joox_next_data(html: Any) -> Any:
    """从 SSR 页面提取 __NEXT_DATA__ JSON。"""
    match = _NEXT_DATA_RE.search(str(html if html is not None else ""))
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except ValueError:
        return None


async def fetch_joox_page(url: str, max_redirect: int = 3) -> dict[str, Any]:
    """拉取页面并手动跟随 3xx（request.py 不自动跟跳；Go 客户端会自动跟）。

    返回 ``{"statusCode", "body", "finalUrl"}``（非字符串 body 视为空串）。
    """
    current = url
    for _ in range(max_redirect + 1):
        res = await http_fetch(current, headers=joox_headers(), timeout=JOOX_TIMEOUT)
        location = res.header("location")
        if 300 <= res.status_code < 400 and location:
            current = urljoin(current, location)
            continue
        body = res.body if isinstance(res.body, str) else ""
        return {"statusCode": res.status_code, "body": body, "finalUrl": current}
    raise RuntimeError("joox 页面重定向次数过多")
