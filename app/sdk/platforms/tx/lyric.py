"""QQ音乐歌词（移植自 sdk/tx/lyric.ts）。

上游返回 QRC（hex 密文），需 decode_qrc 解密后是逐字时间轴格式：
  [起始毫秒,持续毫秒]字(起始,持续)字(起始,持续)...
同一份数据要拆成两路：
  lyric —— 标准 LRC（把逐字标记剥掉，只留行时间）
  yrc   —— 逐字歌词（`<相对起始,持续>` 标记 + 文字）
翻译（trans）与罗马音（roma）的对齐由 fix*_time_tag 按 ±100ms 容差匹配行时间。
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.tx.music_info import get_music_info_by_mid
from app.sdk.platforms.tx.qrc_decode import decode_qrc
from app.sdk.platforms.tx.utils import MUSICU_URL

SUCCESS_CODE = 0

_UA = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36"

_LINE_TIME = re.compile(r"^\[(\d+),\d+\]")
_LINE_TIME2 = re.compile(r"^\[([\d:.]+)\]")
_WORD_TIME = re.compile(r"\(\d+,\d+\)")
_WORD_TIME_ALL = re.compile(r"(\(\d+,\d+\))")
_WORD_TIME_PARTS = re.compile(r"\((\d+),(\d+)\)")
_TIME_SPLIT = re.compile(r"[:.]")
_TAG_HEAD = re.compile(r'^[\S\s]*?LyricContent="')
_TAG_TAIL = re.compile(r'"\/>[\S\s]*?$')

# songmid → songId 缓存；promises 用于合并并发请求（同一首歌并发取歌词只查一次详情）
_song_id_map: dict[str, Any] = {}
_promises: dict[str, asyncio.Task[Any]] = {}


def ms_format(time_ms: int) -> str:
    """毫秒 → `[mm:ss.SSS]`。"""
    ms = time_ms % 1000
    total = time_ms // 1000
    minute = total // 60
    second = total % 60
    return f"[{minute:02d}:{second:02d}.{ms:03d}]"


def parse_lyric(lrc: str) -> dict[str, str]:
    """逐字 QRC 正文 → {lyric: 标准 LRC, yrc: 逐字歌词}。"""
    text = lrc.strip().replace("\r", "")
    if not text:
        return {"lyric": "", "yrc": ""}

    yrc_lines: list[str] = []
    lrc_lines: list[str] = []

    for raw_line in text.split("\n"):
        line = raw_line.strip()
        result = _LINE_TIME.search(line)
        if not result:
            if line.startswith("[offset"):
                yrc_lines.append(line)
                lrc_lines.append(line)
            if _LINE_TIME2.match(line):
                lrc_lines.append(line)
            continue

        start_ms = int(result.group(1))
        start_str = ms_format(start_ms)

        words = _LINE_TIME.sub("", line, count=1)
        lrc_lines.append(f"{start_str}{_WORD_TIME_ALL.sub('', words)}")

        times = _WORD_TIME_ALL.findall(words)
        if not times:
            continue
        marks = []
        for time in times:
            parts = _WORD_TIME_PARTS.fullmatch(time)
            if parts is None:
                continue
            marks.append(f"<{max(int(parts.group(1)) - start_ms, 0)},{parts.group(2)}>")
        word_arr = _WORD_TIME.split(words)
        new_words = "".join(
            f"{mark}{word_arr[index] if index < len(word_arr) else ''}" for index, mark in enumerate(marks)
        )
        yrc_lines.append(f"{start_str}{new_words}")

    return {"lyric": "\n".join(lrc_lines), "yrc": "\n".join(yrc_lines)}


def parse_rlyric(lrc: str) -> str:
    """罗马音（逐字格式）→ 标准 LRC 行。"""
    text = lrc.strip().replace("\r", "")
    if not text:
        return ""

    lines: list[str] = []
    for raw_line in text.split("\n"):
        line = raw_line.strip()
        result = _LINE_TIME.search(line)
        if not result:
            continue
        start_str = ms_format(int(result.group(1)))
        words = _LINE_TIME.sub("", line, count=1)
        lines.append(f"{start_str}{_WORD_TIME_ALL.sub('', words)}")
    return "\n".join(lines)


def remove_tag(text: str) -> str:
    """剥离 `<LyricContent="..." />` 外层标签，只留正文。"""
    return _TAG_TAIL.sub("", _TAG_HEAD.sub("", text))


def get_intv(interval: str) -> int:
    """`mm:ss.SSS` / `m:ss` → 毫秒（沿用原实现的 3600000 系数，两侧比较口径一致）。"""
    if not interval:
        return 0
    if "." not in interval:
        interval += ".0"
    parts = _TIME_SPLIT.split(interval)
    while len(parts) < 3:
        parts.insert(0, "0")
    minute, second, ms = parts[0], parts[1], parts[2]

    def _int(value: str) -> int:
        try:
            return int(value)
        except ValueError:
            return 0

    return _int(minute) * 3600000 + _int(second) * 1000 + _int(ms)


def _align_times(raw_lyric: str, lrc: str) -> str:
    """把 raw_lyric 的行时间替换成 lrc 中时间最近的标签（±100ms 内才算命中）。

    与原文一致：lrc 行是一次性指针，未命中的行被丢弃（不做回补）。
    """
    out: list[str] = []
    lrc_lines = lrc.split("\n")
    for line in raw_lyric.split("\n"):
        result = _LINE_TIME2.match(line)
        if not result:
            continue
        if not _LINE_TIME2.sub("", line, count=1).strip():
            continue
        t1 = get_intv(result.group(1))

        while lrc_lines:
            lrc_line = lrc_lines.pop(0)
            lrc_result = _LINE_TIME2.match(lrc_line)
            if not lrc_result:
                continue
            if abs(t1 - get_intv(lrc_result.group(1))) < 100:
                out.append(_LINE_TIME2.sub(_literal(lrc_result.group(0)), line, count=1))
                break
    return "\n".join(out)


def _literal(text: str) -> Callable[[re.Match[str]], str]:
    r"""替换串按字面量处理（`\` 与组引用需转义；时间标签本身不带这些字符，保持严格）。"""
    return lambda _match: text


def fix_rlrc_time_tag(rlrc: str, lrc: str) -> str:
    return _align_times(rlrc, lrc)


def fix_tlrc_time_tag(tlrc: str, lrc: str) -> str:
    """翻译行对齐。

    原 TS 打算把 `mm:ss.d` 的小数位补齐到 3 位，但写的是
    `time += ''.padStart(3 - n, '0')` —— 对空串补位恒为空，实际是空操作。
    这里保持同样的换算口径（不补位），否则与 TS 版的 tlyric 对齐结果不一致。
    """
    return _align_times(tlrc, lrc)


def parse(lrc: str | None, tlrc: str | None, rlrc: str | None) -> dict[str, str]:
    info = {"lyric": "", "tlyric": "", "rlyric": "", "yrc": ""}
    if lrc:
        parsed = parse_lyric(remove_tag(lrc))
        info["lyric"] = parsed["lyric"]
        info["yrc"] = parsed["yrc"]
    if rlrc:
        info["rlyric"] = fix_rlrc_time_tag(parse_rlyric(remove_tag(rlrc)), info["lyric"])
    if tlrc:
        info["tlyric"] = fix_tlrc_time_tag(tlrc, info["lyric"])
    return info


async def parse_lyric_hex(lrc: str | None, tlrc: str | None, rlrc: str | None) -> dict[str, str]:
    """三路 QRC hex 解密后解析。"""
    lyric, tlyric, rlyric = decode_qrc(lrc), decode_qrc(tlrc), decode_qrc(rlrc)
    return parse(lyric, tlyric, rlyric)


async def get_song_id(song_info: dict[str, Any]) -> Any:
    """songId 优先；否则用 songmid 反查（带缓存 + 并发合并）。"""
    song_id = song_info.get("songId")
    if song_id:
        return song_id
    songmid = str(song_info.get("songmid") or "")
    if not songmid:
        raise RuntimeError("获取歌曲信息失败")
    if songmid in _song_id_map:
        return _song_id_map[songmid]

    task = _promises.get(songmid)
    if task is None:
        task = asyncio.ensure_future(get_music_info_by_mid(songmid))
        _promises[songmid] = task
    try:
        info = await asyncio.shield(task)
    finally:
        _promises.pop(songmid, None)
    if not info:
        raise RuntimeError("获取歌曲信息失败")
    _song_id_map[songmid] = info.get("songId")
    return info.get("songId")


async def _fetch(song_id: Any, retry_num: int) -> dict[str, str]:
    resp = await http_fetch(
        MUSICU_URL,
        method="post",
        headers={"referer": "https://y.qq.com", "user-agent": _UA},
        body={
            "comm": {"ct": "19", "cv": "1859", "uin": "0"},
            "req": {
                "method": "GetPlayLyricInfo",
                "module": "music.musichallSong.PlayLyricInfo",
                "param": {
                    "format": "json",
                    "crypt": 1,
                    "ct": 19,
                    "cv": 1873,
                    "interval": 0,
                    "lrc_t": 0,
                    "qrc": 1,
                    "qrc_t": 0,
                    "roma": 1,
                    "roma_t": 0,
                    "songID": song_id,
                    "trans": 1,
                    "trans_t": 0,
                    "type": -1,
                },
            },
        },
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    req = body.get("req") or {}
    data = req.get("data") or {}
    if body.get("code") != SUCCESS_CODE or req.get("code") != SUCCESS_CODE:
        return await _retry(song_id, retry_num)
    return await parse_lyric_hex(data.get("lyric"), data.get("trans"), data.get("roma"))


async def _retry(song_id: Any, retry_num: int) -> dict[str, str]:
    """失败重试（上限 3 次，文案与原文一致：Get lyric failed）。"""
    retry_num += 1
    if retry_num > 3:
        raise RuntimeError("Get lyric failed")
    # 原实现在此处把 songId 当 song_info 再走一次 getSongId（会解析成空 mid 而必然失败），
    # 这里直接复用已取到的 songId 重发同一请求，降级链（同接口重试）保持一致。
    return await _fetch(song_id, retry_num)


async def get_lyric(song_info: dict[str, Any]) -> dict[str, str]:
    """Platform.get_lyric 契约：song_info → {lyric, tlyric, rlyric, yrc}。"""
    song_id = await get_song_id(song_info)
    return await _fetch(song_id, 0)
