"""酷狗 KRC 歌词解密（对应 sdk/kg/krcDecode.ts）。

密文是 base64 → 去掉 4 字节头 → 与 16 字节固定 key 循环异或 → zlib inflate。
解密后是带 `[start,duration]` 行级标签与 `<offset,duration,0>` 字级标签的 KRC 文本，
另外 `[language:<base64>]` 行里藏着 base64(JSON) 的逐行翻译，需按行号拼回 LRC。
"""

from __future__ import annotations

import base64
import json
import re
import zlib
from typing import Any

from app.sdk.common.utils import decode_name

ENC_KEY = bytes([0x40, 0x47, 0x61, 0x77, 0x5E, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2D, 0xCE, 0xD2, 0x6E, 0x69])

_HEAD_EXP = re.compile(r"^.*\[id:\$\w+\]\n")
_TRANS_EXP = re.compile(r"\[language:([\w=\\/+]+)\]")
_TRANS_LINE_EXP = re.compile(r"\[language:[\w=\\/+]+\]\n")
_LINE_EXP = re.compile(r"\[((\d+),\d+)\].*")
_WORD_TAG_EXP = re.compile(r"<(\d+,\d+),\d+>")
_PLAIN_TAG_EXP = re.compile(r"<\d+,\d+>")


def _xor_decode(data: str) -> str:
    if not data:
        return ""
    buf = bytearray(base64.b64decode(data)[4:])
    for i in range(len(buf)):
        buf[i] ^= ENC_KEY[i % 16]
    return zlib.decompress(bytes(buf)).decode("utf-8", errors="replace")


def _format_time(ms: int) -> str:
    """毫秒 → `mm:ss.ms`（毫秒段与原文一致不补零）。"""
    minutes, rem = divmod(ms, 60000)
    return f"{minutes:02d}:{rem // 1000:02d}.{ms % 1000}"


def _lrc_line(value: Any) -> str:
    """rlyric/tlyric 的单项是字符串数组（逐字），字符串形态也容忍。"""
    if isinstance(value, list):
        return "".join(str(item) for item in value)
    return "" if value is None else str(value)


def parse_lyric(text: str) -> dict[str, str]:
    text = text.replace("\r", "")
    if _HEAD_EXP.match(text):
        text = _HEAD_EXP.sub("", text, count=1)

    rlyric: list[Any] | None = None
    tlyric: list[Any] | None = None
    trans = _TRANS_EXP.search(text)
    if trans:
        text = _TRANS_LINE_EXP.sub("", text, count=1)
        try:
            payload = json.loads(base64.b64decode(trans.group(1)).decode("utf-8", errors="replace"))
        except ValueError:
            payload = {}
        for item in payload.get("content") or []:
            if item.get("type") == 0:
                rlyric = item.get("lyricContent")
            elif item.get("type") == 1:
                tlyric = item.get("lyricContent")

    index = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal index
        line_match = _LINE_EXP.match(match.group(0))
        time_ms = int(line_match.group(2)) if line_match else 0
        stamp = _format_time(time_ms)
        if rlyric is not None:
            rlyric[index] = f"[{stamp}]{_lrc_line(rlyric[index]) if index < len(rlyric) else ''}"
        if tlyric is not None:
            tlyric[index] = f"[{stamp}]{_lrc_line(tlyric[index]) if index < len(tlyric) else ''}"
        index += 1
        return match.group(0).replace(match.group(1), stamp, 1)

    yrc = re.sub(r"\[((\d+),\d+)\].*", repl, text)
    rlyric_text = "\n".join(str(item) for item in rlyric) if rlyric else ""
    tlyric_text = "\n".join(str(item) for item in tlyric) if tlyric else ""
    yrc = _WORD_TAG_EXP.sub(r"<\1>", yrc)
    yrc = decode_name(yrc)
    lyric = _PLAIN_TAG_EXP.sub("", yrc)
    return {
        "lyric": lyric,
        "tlyric": decode_name(tlyric_text),
        "rlyric": decode_name(rlyric_text),
        "yrc": yrc,
    }


async def decode_krc(data: str) -> dict[str, str]:
    return parse_lyric(_xor_decode(data))


__all__ = ["decode_krc", "parse_lyric"]
