"""酷我平台工具（对应 sdk/kw/util.ts）。

四块内容：legacy 接口的 JS 对象字面量转 JSON、歌手名格式化、逐字歌词（lrcx）解析、
wbd 榜单接口的 AES-128-ECB 加解密与签名。
"""

from __future__ import annotations

import base64
import json
import math
import random
import re
import time
from typing import Any
from urllib.parse import quote, unquote

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import to_md5

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
MOBI_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/537.36"
)
HOME_URL = "https://www.kuwo.cn/"

# 单引号替换：原文是一条含变长后顾断言的正则，Python re 不支持变长 lookbehind，
# 因此拆成「引号前是 {,: 」与「引号后是 },: 」两步，覆盖范围与原文等价。
_QUOTE_START = re.compile(r"(?P<pre>[{:,]\s*)'")
_QUOTE_END = re.compile(r"'(?P<post>\s*[}:,])")


def obj_str2json(text: str) -> Any:
    """legacy r.s 返回的是 JS 对象字面量（单引号 + 未加引号的形态），先转成合法 JSON。

    专辑详情实测确认仍是这一形态，不能直接 json.loads。
    """
    fixed = _QUOTE_START.sub(r'\g<pre>"', text)
    fixed = _QUOTE_END.sub(r'"\g<post>', fixed)
    return json.loads(fixed)


def format_singer(raw: str) -> str:
    """酷我用 `&` 分隔合唱歌手，统一换成顿号。"""
    return raw.replace("&", "、")


# ---------- 逐字歌词 ----------

_WORD_LINE = re.compile(r"^(\[\d{1,2}:.*\d{1,4}\])\s*(\S+(?:\s+\S+)*)?\s*")
_TAG_LINE = re.compile(r"\[(ver|ti|ar|al|offset|by|kuwo):\s*(\S+(?:\s+\S+)*)\s*\]")
_WORD_TIME = re.compile(r"<(-?\d+),(-?\d+)(?:,-?\d+)?>")
_LINE_SPLIT = re.compile(r"\r\n|\r|\n")


def _js_number(value: float) -> str:
    """JS 的 Number → String：整数值不带小数点，其余取最短往返表示（与 repr 同）。"""
    return str(int(value)) if float(value).is_integer() else repr(float(value))


class LrcTools:
    """lrcx 逐字歌词解析器。原实现靠 Object.create 做每轮隔离，这里用新实例。"""

    def __init__(self) -> None:
        self.offset = 1
        self.offset2 = 1
        self.is_ok = True
        self.lines: list[str] = []
        self.tags: list[str] = []

    def get_word_info(self, first: str, second: str, prev: dict[str, Any] | None) -> dict[str, Any]:
        offset = int(first)
        offset2 = int(second)
        start = abs((offset + offset2) / (self.offset * 2))
        end = abs((offset - offset2) / (self.offset2 * 2)) + start
        if prev is not None and start < prev["end"]:
            # 上一句被本句起点截断，需要回头改写已拼进 words 的那一段
            prev["end"] = start
            if prev["start"] > prev["end"]:
                prev["start"] = prev["end"]
            prev["new"] = f"<{_js_number(prev['start'])},{_js_number(prev['end'] - prev['start'])}>"
        return {"start": start, "end": end, "text": f"<{_js_number(start)},{_js_number(end - start)}>"}

    def parse_line(self, line: str) -> None:
        if len(line) < 6:
            return
        match = _WORD_LINE.match(line)
        if match:
            head = match.group(1)
            words = match.group(2) or ""
            spans = [item.group(0) for item in _WORD_TIME.finditer(words)]
            if not spans:
                return
            prev: dict[str, Any] | None = None
            for span in spans:
                found = _WORD_TIME.search(span)
                if found is None:
                    continue
                info = self.get_word_info(found.group(1), found.group(2), prev)
                words = words.replace(span, info["text"], 1)
                if prev is not None and prev.get("new"):
                    words = words.replace(prev["text"], prev["new"], 1)
                prev = info
            self.lines.append(head + words)
            return
        tag = _TAG_LINE.search(line)
        if tag is None:
            return
        if tag.group(1) != "kuwo":
            self.tags.append(line)
            return
        content = tag.group(2)
        if "][" in content:
            content = content[: content.index("][")]
        try:
            value = int(content.strip(), 8)
        except ValueError:
            self.is_ok = False
            return
        self.offset = int(value / 10)
        self.offset2 = value % 10
        # 原文对 NaN/0 一律判失败，等价于这里两个偏移都非零
        if self.offset == 0 or self.offset2 == 0:
            self.is_ok = False


def parse_yrc(lrc: str) -> str:
    """把歌词里的 lrcx 时间标记规范化；失败抛 RuntimeError（原文文案 failed）。"""
    tools = LrcTools()
    for line in _LINE_SPLIT.split(lrc):
        if not tools.is_ok:
            raise RuntimeError("failed")
        tools.parse_line(line)
    if not tools.lines:
        return ""
    merged = "\n".join(tools.lines)
    if tools.tags:
        merged = "\n".join(tools.tags) + "\n" + merged
    return merged


# ---------- wbd 榜单接口加解密 ----------

WBD_APP_ID = "y67sprxhhpws"
_WBD_KEY = bytes([112, 87, 39, 61, 199, 250, 41, 191, 57, 68, 45, 114, 221, 94, 140, 228])


def _aes_ecb(data: bytes, *, encrypt: bool) -> bytes:
    cipher = Cipher(algorithms.AES(_WBD_KEY), modes.ECB())
    if encrypt:
        pad = 16 - len(data) % 16
        padded = data + bytes([pad]) * pad
        context = cipher.encryptor()
        return context.update(padded) + context.finalize()
    context = cipher.decryptor()
    out = context.update(data) + context.finalize()
    pad = out[-1] if out else 0
    return out[:-pad] if 0 < pad <= 16 else out


def wbd_decode_data(payload: str) -> Any:
    """解码 wbd 响应：URL 编码的 base64 → AES-128-ECB 解密 → JSON。"""
    raw = base64.b64decode(unquote(payload))
    return json.loads(_aes_ecb(raw, encrypt=False).decode())


def wbd_build_param(json_data: Any) -> str:
    """构造 wbd 请求 query：加密体 + 毫秒时间戳 + appId + MD5 大写签名。"""
    data = json.dumps(json_data, ensure_ascii=False, separators=(",", ":")).encode()
    time_ms = int(time.time() * 1000)
    encoded = base64.b64encode(_aes_ecb(data, encrypt=True)).decode()
    sign = to_md5(f"{WBD_APP_ID}{encoded}{time_ms}").upper()
    return f"data={quote(encoded, safe='')}&time={time_ms}&appId={WBD_APP_ID}&sign={sign}"


async def fetch_home_set_cookie() -> list[str]:
    """取酷我首页下发的全部 Set-Cookie。

    用 http_fetch 的 set_cookies（原始多值头），而不是折叠后的 headers dict——
    Secret 签名必须认出动态下发的 Hm_Iuvt_* cookie（名字与值均随机），
    同名头被折叠会恰好丢掉目标 cookie。
    """
    resp = await http_fetch(HOME_URL, headers={"User-Agent": UA}, timeout=15_000)
    return list(resp.set_cookies)


def random_digits() -> int:
    """JS 的 Math.round(1e9 * Math.random()) —— round 是四舍五入，不是 Python 的银行家舍入。"""
    return math.floor(1e9 * random.random() + 0.5)
