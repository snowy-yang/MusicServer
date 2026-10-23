"""网易云歌词（移植自 sdk/wy/lyric.ts，参考 Binaryify/NeteaseCloudMusicApi 的 module/lyric_new.js）。

上游返回 yrc（逐字）+ lrc（逐行）+ 各语种翻译/rlrc。逐字歌词的时间标签是
`[起始ms,时长ms](词起始ms,词时长ms,0)词` 形态，需要转换成标准 LRC + 富文本 `<偏移,时长>` 标签。
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.wy.utils import UA_LINUX_CHROME
from app.sdk.platforms.wy.utils.crypto import eapi

RX_INFO = re.compile(r'^{"')
RX_LINE_TIME = re.compile(r"^\[(\d+),\d+\]")
RX_WORD_TIME = re.compile(r"\(\d+,\d+,\d+\)")
RX_WORD_TIME_ALL = re.compile(r"(\(\d+,\d+,\d+\))")
RX_WORD_ITEM = re.compile(r"\((\d+),(\d+),\d+\)")

LYRIC_HOST = "https://interface3.music.163.com/eapi/song/lyric/v1"


def ms_format(time_ms: Any) -> str:
    """毫秒 → `[mm:ss.SSS]`。非数字返回空串（原实现用 Number.isNaN 判定）。"""
    try:
        total = int(float(time_ms))
    except (TypeError, ValueError):
        return ""
    if total < 0:
        return ""
    ms = total % 1000
    seconds = total // 1000
    # 与原实现一致：毫秒不补齐（JS 的 `timeMs % 1000` 直接插值）
    return f"[{seconds // 60:02d}:{seconds % 60:02d}.{ms}]"


def parse_lyric(lines: list[str]) -> dict[str, str]:
    yrc_lines: list[str] = []
    lrc_lines: list[str] = []

    for raw_line in lines:
        line = raw_line.strip()
        match = RX_LINE_TIME.match(line)
        if not match:
            if line.startswith("[offset"):
                yrc_lines.append(line)
                lrc_lines.append(line)
            continue

        start_ms = int(match.group(1))
        start_str = ms_format(start_ms)
        if not start_str:
            continue

        words = RX_LINE_TIME.sub("", line)
        lrc_lines.append(start_str + RX_WORD_TIME_ALL.sub("", words))

        word_times = RX_WORD_TIME_ALL.findall(words)
        if not word_times:
            continue
        tags = []
        for chunk in word_times:
            item = RX_WORD_ITEM.search(chunk)
            if not item:
                continue
            tags.append(f"<{max(int(item.group(1)) - start_ms, 0)},{item.group(2)}>")
        word_arr = RX_WORD_TIME.split(words)[1:]  # 首段是第一个时间标签前的内容
        new_words = "".join(
            f"{tag}{word_arr[index] if index < len(word_arr) else ''}" for index, tag in enumerate(tags)
        )
        yrc_lines.append(f"{start_str}{new_words}")

    return {"lyric": "\n".join(lrc_lines), "yrc": "\n".join(yrc_lines)}


def parse_header_info(text: Any) -> list[str] | None:
    """清洗歌词文本：去掉 \\r，把 `{"t":ms,"c":[{"tx":...}]}` 形式的逐字行转成标准 LRC 行。"""
    if text is None:
        return None
    raw = str(text).strip().replace("\r", "")
    if not raw:
        return None
    out: list[str] = []
    for line in raw.split("\n"):
        if not RX_INFO.match(line):
            out.append(line)
            continue
        try:
            info = json.loads(line)
        except (ValueError, TypeError):
            out.append("")
            continue
        tag = ms_format(info.get("t"))
        if not tag:
            out.append("")
            continue
        out.append(tag + "".join(str(chunk.get("tx", "")) for chunk in info.get("c") or []))
    return out


def get_intv(interval: Any) -> int:
    """`mm:ss.SSS`（或 `hh:mm:ss.SSS`）→ 毫秒。"""
    if not interval:
        return 0
    text = str(interval)
    if "." not in text:
        text += ".0"
    parts = re.split(r"[:.]", text)
    while len(parts) < 3:
        parts.insert(0, "0")
    minute, second, milli = parts[0], parts[1], parts[2]

    def to_int(value: str) -> int:
        try:
            return int(value)
        except ValueError:
            return 0

    return to_int(minute) * 3_600_000 + to_int(second) * 1000 + to_int(milli)


def fix_time_tag(lrc: str, target_lrc: str) -> str:
    """把 target 的文本按时间接近（<100ms）对齐到 lrc 的时间标签上。"""
    rx_time = re.compile(r"^\[([\d:.]+)\]")
    lrc_lines = lrc.split("\n")
    new_lrc: list[str] = []
    temp: list[str] = []

    for line in target_lrc.split("\n"):
        match = rx_time.match(line)
        if not match:
            continue
        words = rx_time.sub("", line)
        if not words.strip():
            continue
        t1 = get_intv(match.group(1))

        while lrc_lines:
            lrc_line = lrc_lines.pop(0)
            lrc_match = rx_time.match(lrc_line)
            if not lrc_match:
                continue
            t2 = get_intv(lrc_match.group(1))
            if abs(t1 - t2) < 100:
                merged = rx_time.sub(lrc_match.group(0), line).strip()
                if not merged:
                    continue
                new_lrc.append(merged)
                break
            temp.append(lrc_line)
        lrc_lines = [*temp, *lrc_lines]
        temp = []

    return "\n".join(new_lrc)


def parse(y_lrc: Any, yt_lrc: Any, yr_lrc: Any, lrc: Any, tlrc: Any, rlrc: Any) -> dict[str, str]:
    """优先用逐字歌词（yrc）合成，缺失时退回普通 LRC。"""
    info = {"lyric": "", "tlyric": "", "rlyric": "", "yrc": ""}
    if y_lrc:
        lines = parse_header_info(y_lrc)
        if lines:
            result = parse_lyric(lines)
            if yt_lrc:
                t_lines = parse_header_info(yt_lrc)
                if t_lines:
                    info["tlyric"] = fix_time_tag(result["lyric"], "\n".join(t_lines))
            if yr_lrc:
                r_lines = parse_header_info(yr_lrc)
                if r_lines:
                    info["rlyric"] = fix_time_tag(result["lyric"], "\n".join(r_lines))

            headers = "\n".join(line for line in lines if re.match(r"^\[[\d:.]+\]", line))
            info["lyric"] = f"{headers}\n{result['lyric']}"
            info["yrc"] = result["yrc"]
            return info

    for key, value in (("lyric", lrc), ("tlyric", tlrc), ("rlyric", rlrc)):
        if not value:
            continue
        parsed_lines = parse_header_info(value)
        if parsed_lines:
            info[key] = "\n".join(parsed_lines)
    return info


def fix_time_label(lrc: Any, tlrc: Any = None, romalrc: Any = None) -> tuple[Any, Any, Any]:
    """修正 `[mm:ss:SS]` 这类把毫秒写成第二冒号的错误时间标签（社区通行做法）。"""
    if not lrc:
        return lrc, tlrc, romalrc
    text = str(lrc)
    new_lrc = re.sub(r"\[(\d{2}:\d{2}):(\d{2})\]", r"[\1.\2]", text)
    new_tlrc = re.sub(r"\[(\d{2}:\d{2}):(\d{2})\]", r"[\1.\2]", tlrc) if isinstance(tlrc, str) else tlrc
    if new_lrc != text or new_tlrc != tlrc:
        lrc, tlrc = new_lrc, new_tlrc
        if isinstance(romalrc, str):
            romalrc = re.sub(r"\[(\d{2}:\d{2}):(\d{2,3})\]", r"[\1.\2]", romalrc)
            romalrc = re.sub(r"\[(\d{2}:\d{2}\.\d{2})0\]", r"[\1]", romalrc)
    return lrc, tlrc, romalrc


def _pick_lyric(block: Any) -> Any:
    return block.get("lyric") if isinstance(block, dict) else None


async def get_lyric(song_info: dict[str, Any]) -> dict[str, str]:
    """取歌词。原文失败文案：Get lyric failed。"""
    resp = await http_fetch(
        LYRIC_HOST,
        method="post",
        headers={"User-Agent": UA_LINUX_CHROME, "origin": "https://music.163.com"},
        form=eapi(
            "/api/song/lyric/v1",
            {
                "id": song_info.get("songmid"),
                "cp": False,
                "tv": 0,
                "lv": 0,
                "rv": 0,
                "kv": 0,
                "yv": 0,
                "ytv": 0,
                "yrv": 0,
            },
        ),
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != 200 or not _pick_lyric(body.get("lrc")):
        raise RuntimeError("Get lyric failed")

    lrc, tlrc, romalrc = fix_time_label(
        _pick_lyric(body.get("lrc")), _pick_lyric(body.get("tlyric")), _pick_lyric(body.get("romalrc"))
    )
    info = parse(
        _pick_lyric(body.get("yrc")),
        _pick_lyric(body.get("ytlrc")),
        _pick_lyric(body.get("yromalrc")),
        lrc,
        tlrc,
        romalrc,
    )
    if not info["lyric"]:
        raise RuntimeError("Get lyric failed")
    return info
