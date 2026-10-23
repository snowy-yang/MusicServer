"""QQ音乐 musics.fcg 签名（移植自 sdk/tx/utils/crypto.ts）。

算法：SHA1 摘要的十六进制串 → 按固定下标取两段字符 → 第三段用固定混淆表
与摘要每字节异或后 base64（剔除 + / = 与反斜杠）→ 拼成 `zzc{part1}{b64}{part2}` 转小写。
"""

from __future__ import annotations

import base64
import hashlib
import re

PART_1_INDEXES = (23, 14, 6, 36, 16, 40, 7, 19)
PART_2_INDEXES = (16, 1, 32, 12, 19, 27, 8, 5)
SCRAMBLE_VALUES = (
    89,
    39,
    179,
    150,
    218,
    82,
    58,
    252,
    177,
    52,
    186,
    123,
    120,
    64,
    242,
    133,
    143,
    161,
    121,
    179,
)
_B64_STRIP = re.compile(r"[\\/+=]")


def _pick_by_indexes(hash_hex: str, indexes: tuple[int, ...]) -> str:
    """按固定下标取字符。

    PART_1_INDEXES 含下标 40，而 SHA1 十六进制串正好 40 字符（合法下标 0–39）。
    TS 侧 `hash[40]` 取到 undefined，`join('')` 会把它并成空串；Python 直接下标会抛
    IndexError，因此这里显式跳过越界下标，保持与上游签名逐字节一致。
    """
    return "".join(hash_hex[index] for index in indexes if 0 <= index < len(hash_hex))


def zzc_sign(text: str) -> str:
    hash_hex = hashlib.sha1(text.encode()).hexdigest()
    part1 = _pick_by_indexes(hash_hex, PART_1_INDEXES)
    part2 = _pick_by_indexes(hash_hex, PART_2_INDEXES)
    scrambled = bytes(value ^ int(hash_hex[i * 2 : i * 2 + 2], 16) for i, value in enumerate(SCRAMBLE_VALUES))
    part3 = _B64_STRIP.sub("", base64.b64encode(scrambled).decode())
    return f"zzc{part1}{part3}{part2}".lower()
