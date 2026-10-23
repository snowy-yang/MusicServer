"""通用工具函数（对应原 sdk/common/utils.ts 与 sdk/utils.ts）。"""

from __future__ import annotations

import hashlib
import math
import re
import time
from collections.abc import Iterable, Mapping
from datetime import datetime
from typing import Any


def to_md5(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def as_dict(value: Any) -> dict[str, Any]:
    """上游 ``x?.field ?? {}`` 的安全取法：非 dict 一律当空 dict。"""
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    """上游 ``x ?? []`` 的安全取法：非 list 一律当空列表。"""
    return value if isinstance(value, list) else []


def size_formate(size: float | int | None) -> str:
    """将字节数格式化为可读字符串。"""
    if not size:
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB"]
    number = math.floor(math.log(size) / math.log(1024))
    number = min(number, len(units) - 1)
    return f"{size / math.pow(1024, number):.2f} {units[number]}"


def format_play_time(seconds: float | int | str | None) -> str:
    """秒数 → mm:ss；0 返回 --/--。"""
    try:
        value = float(seconds)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "--/--"
    if math.isnan(value) or value < 0:
        value = 0
    minutes = int(value // 60)
    secs = int(value % 60)
    if minutes == 0 and secs == 0:
        return "--/--"
    return f"{minutes:02d}:{secs:02d}"


def date_format(value: Any, fmt: str = "Y-M-D h:m:s") -> str:
    """时间对象/时间戳/字符串 → 日期字符串（Y/M/D/h/m/s 占位）。"""
    if not value:
        return ""
    if isinstance(value, datetime):
        date = value
    elif isinstance(value, (int, float)):
        date = datetime.fromtimestamp(value / 1000 if value > 1e11 else value)
    elif isinstance(value, str):
        raw = value
        if "T" not in raw:
            raw = raw.split(".")[0].replace("-", "/")
        parsed: datetime | None = None
        for pattern in ("%Y/%m/%d %H:%M:%S", "%Y/%m/%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
            try:
                parsed = datetime.strptime(raw[: len(pattern) + 10], pattern)
                break
            except ValueError:
                continue
        if parsed is None:
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                return ""
        date = parsed
    else:
        return ""
    return (
        fmt.replace("Y", str(date.year))
        .replace("M", f"{date.month:02d}")
        .replace("D", f"{date.day:02d}")
        .replace("h", f"{date.hour:02d}")
        .replace("m", f"{date.minute:02d}")
        .replace("s", f"{date.second:02d}")
    )


def date_format2(timestamp_ms: float | int) -> str:
    """相对时间格式化（用于评论时间）。"""
    differ = int((time.time() * 1000 - float(timestamp_ms)) / 1000)
    if differ < 60:
        return f"{differ}秒前"
    if differ < 3600:
        return f"{differ // 60}分钟前"
    if differ < 86400:
        return f"{differ // 3600}小时前"
    if differ < 2592000:
        return f"{differ // 86400}天前"
    return date_format(timestamp_ms)


def format_play_count(num: float | int | None) -> str:
    if num is None:
        return "0"
    if num > 100000000:
        return f"{int(num / 10000000) / 10}亿"
    if num > 10000:
        return f"{int(num / 1000) / 10}万"
    return str(num)


_ENTITY_MAP = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
}


def decode_name(text: Any = "") -> str:
    """解码 HTML 实体。"""
    if not text:
        return ""
    if not isinstance(text, str):
        text = str(text)
    for entity, char in _ENTITY_MAP.items():
        text = text.replace(entity, char)
    return re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), text)


def format_singer_name(
    singers: Iterable[Mapping[str, Any]] | str | None,
    name_key: str = "name",
    join: str = "、",
) -> str:
    """歌手数组或字符串 → 展示名（数组按 name_key 提取后 join）。"""
    if isinstance(singers, (list, tuple)):
        names = [str(item[name_key]) for item in singers if isinstance(item, Mapping) and item.get(name_key)]
        return decode_name(join.join(names))
    return decode_name(str(singers or ""))


def pick(data: Any, *keys: str, default: Any = None) -> Any:
    """沿键路径取值（dict 缺失返回 default），迁移时统一空值访问。"""
    cur = data
    for key in keys:
        if isinstance(cur, Mapping):
            cur = cur.get(key)
        else:
            return default
        if cur is None:
            return default
    return cur
