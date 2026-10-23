"""酷我歌词（对应 sdk/kw/lyric.ts）。

`newlyric.kuwo.cn/newlyric.lrc?<params>`：params 是明文字符串与 `yeelion` 逐字节异或
后的 base64。响应体是 zlib 压缩 + 可选 yeelion 异或，由 `lyric_decode` 还原。

歌词分两种形态：普通 lrc（`[mm:ss.xx]文本`）与 lrcx/逐字（每行带 `<start,dur>` 标记）。
lrcx 走 `util.parse_yrc` 归一到 `yrc` 字段，`lyric`/`tlyric` 里的逐字标记则剥掉，
保持纯 lrc 可直接给播放器。
"""

from __future__ import annotations

import base64
import json
import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import decode_name
from app.sdk.platforms.kw.lyric_decode import handle_kw_decode_lyric
from app.sdk.platforms.kw.util import parse_yrc

_BUF_KEY = b"yeelion"

LYRIC_API = "http://newlyric.kuwo.cn/newlyric.lrc"

_TIME_EXP = re.compile(r"^\[([\d:.]*)\]")
_TAG_LINE = re.compile(r"\[(ver|ti|ar|al|offset|by|kuwo):\s*(\S+(?:\s+\S+)*)\s*\]")
_EXIST_TIME_EXP = re.compile(r"\[\d{1,2}:.*\d{1,4}\]")
_LYRICX_TAG = re.compile(r"^<-?\d+,-?\d+>")
_WORD_TIME_ALL = re.compile(r"<(-?\d+),(-?\d+)(?:,-?\d+)?>")


def build_params(songmid: str, is_get_lyricx: bool) -> str:
    """明文参数与 `yeelion` 循环异或后 base64。

    原实现用 `new Uint16Array` 中转再 `Buffer.from(output)`；Node 对 TypedArray
    走 fromArrayLike，按元素截断成 8 位字节，等价于这里的逐字节异或。
    """
    params = f"user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_{songmid}"
    if is_get_lyricx:
        params += "&lrcx=1"
    raw = params.encode()
    return base64.b64encode(bytes(byte ^ _BUF_KEY[index % len(_BUF_KEY)] for index, byte in enumerate(raw))).decode()


def _sort_lrc_arr(arr: list[dict[str, str]]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """按时间去重：重复时间视为翻译行，挤进 lrc_t。

    全部行都没有逐字标记、且「翻译行」占比异常时，认为数据错乱并抛 failed。
    """
    lrc_set: set[str] = set()
    lrc: list[dict[str, str]] = []
    lrc_t: list[dict[str, str]] = []
    is_lyricx = False
    for item in arr:
        if item["time"] in lrc_set:
            if len(lrc) < 2:
                continue
            t_item = lrc.pop()
            t_item["time"] = lrc[-1]["time"]
            lrc_t.append(t_item)
            lrc.append(item)
        else:
            lrc.append(item)
            lrc_set.add(item["time"])
        if not is_lyricx and _LYRICX_TAG.match(item["text"]):
            is_lyricx = True
    if not is_lyricx and len(lrc_t) > len(lrc) * 0.3 and len(lrc) - len(lrc_t) > 6:
        raise RuntimeError("failed")
    return lrc, lrc_t


def _transform_lrc(tags: list[str], lrc_list: list[dict[str, str]]) -> str:
    body = "".join(f"[{item['time']}]{item['text']}\n" for item in lrc_list)
    return "\n".join(tags) + "\n" + body


def parse_lrc(lrc: str) -> dict[str, str]:
    tags: list[str] = []
    arr: list[dict[str, str]] = []
    for raw_line in re.split(r"\r\n|\r|\n", lrc):
        line = raw_line.strip()
        match = _TIME_EXP.match(line)
        if match:
            text = _TIME_EXP.sub("", line, count=1).strip()
            time = match.group(1)
            # 只有两位小数的补一个 0，与三位/更长的保持同宽
            if re.search(r"\.\d\d$", time):
                time += "0"
            arr.append({"time": time, "text": text})
        elif _TAG_LINE.search(line):
            tags.append(line)

    lrc_list, lrc_t = _sort_lrc_arr(arr)
    return {
        "lyric": decode_name(_transform_lrc(tags, lrc_list)),
        "tlyric": decode_name(_transform_lrc(tags, lrc_t)) if lrc_t else "",
    }


async def get_lyric(song_info: dict[str, Any], is_get_lyricx: bool = True) -> dict[str, str]:
    songmid = str(song_info.get("songmid") or "")
    resp = await http_fetch(f"{LYRIC_API}?{build_params(songmid, is_get_lyricx)}")
    if resp.status_code != 200:
        raise RuntimeError(json.dumps(resp.body, ensure_ascii=False))

    base64_data = await handle_kw_decode_lyric(base64.b64encode(resp.raw).decode(), is_get_lyricx)
    try:
        lrc_info = parse_lrc(base64.b64decode(base64_data).decode("utf-8", errors="replace"))
    except Exception as err:
        raise RuntimeError("Get lyric failed") from err

    if lrc_info.get("tlyric"):
        lrc_info["tlyric"] = _WORD_TIME_ALL.sub("", lrc_info["tlyric"])
    # yrc 解析失败只代表这份歌词没有逐字数据，不影响普通歌词返回
    try:
        lrc_info["yrc"] = parse_yrc(lrc_info["lyric"])
    except Exception:  # noqa: BLE001
        lrc_info["yrc"] = ""
    lrc_info["lyric"] = _WORD_TIME_ALL.sub("", lrc_info["lyric"])
    if not _EXIST_TIME_EXP.search(lrc_info["lyric"]):
        raise RuntimeError("Get lyric failed")
    return lrc_info
