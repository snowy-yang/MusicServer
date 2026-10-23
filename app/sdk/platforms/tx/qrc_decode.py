"""QRC 歌词解密（移植自 sdk/tx/qrcDecode.ts）。

数据流程：hex 字符串 → 字节 → 3DES(DES-EDE3, ECB, 无填充) 解密 → zlib inflate → UTF-8 文本。

注意：QRC 用的是**非标准** DES 变体，S-box 中 S2[23]=15、S4[53]=10 两处与标准 DES
（14、1）不同。这两个值与原 C++ native 插件一致，改成标准值会导致解密结果全错。
下表逐字节对应原实现，不要「顺手修正」。

原 TS 的 inflate 用 `finishFlush: Z_SYNC_FLUSH` 容忍尾部不完整流（3DES 分组补位会产生
尾部垃圾/截断），Python 侧同样先尝试完整解压，失败后分块累积已解出部分。
"""

from __future__ import annotations

import zlib
from collections.abc import Sequence

DES_ENCRYPT = 1
DES_DECRYPT = 0

_MASK32 = 0xFFFFFFFF
_MASK8 = 0xFF

SBOX: tuple[tuple[int, ...], ...] = (
    (
        14,
        4,
        13,
        1,
        2,
        15,
        11,
        8,
        3,
        10,
        6,
        12,
        5,
        9,
        0,
        7,
        0,
        15,
        7,
        4,
        14,
        2,
        13,
        1,
        10,
        6,
        12,
        11,
        9,
        5,
        3,
        8,
        4,
        1,
        14,
        8,
        13,
        6,
        2,
        11,
        15,
        12,
        9,
        7,
        3,
        10,
        5,
        0,
        15,
        12,
        8,
        2,
        4,
        9,
        1,
        7,
        5,
        11,
        3,
        14,
        10,
        0,
        6,
        13,
    ),
    (
        15,
        1,
        8,
        14,
        6,
        11,
        3,
        4,
        9,
        7,
        2,
        13,
        12,
        0,
        5,
        10,
        3,
        13,
        4,
        7,
        15,
        2,
        8,
        15,
        12,
        0,
        1,
        10,
        6,
        9,
        11,
        5,
        0,
        14,
        7,
        11,
        10,
        4,
        13,
        1,
        5,
        8,
        12,
        6,
        9,
        3,
        2,
        15,
        13,
        8,
        10,
        1,
        3,
        15,
        4,
        2,
        11,
        6,
        7,
        12,
        0,
        5,
        14,
        9,
    ),
    (
        10,
        0,
        9,
        14,
        6,
        3,
        15,
        5,
        1,
        13,
        12,
        7,
        11,
        4,
        2,
        8,
        13,
        7,
        0,
        9,
        3,
        4,
        6,
        10,
        2,
        8,
        5,
        14,
        12,
        11,
        15,
        1,
        13,
        6,
        4,
        9,
        8,
        15,
        3,
        0,
        11,
        1,
        2,
        12,
        5,
        10,
        14,
        7,
        1,
        10,
        13,
        0,
        6,
        9,
        8,
        7,
        4,
        15,
        14,
        3,
        11,
        5,
        2,
        12,
    ),
    (
        7,
        13,
        14,
        3,
        0,
        6,
        9,
        10,
        1,
        2,
        8,
        5,
        11,
        12,
        4,
        15,
        13,
        8,
        11,
        5,
        6,
        15,
        0,
        3,
        4,
        7,
        2,
        12,
        1,
        10,
        14,
        9,
        10,
        6,
        9,
        0,
        12,
        11,
        7,
        13,
        15,
        1,
        3,
        14,
        5,
        2,
        8,
        4,
        3,
        15,
        0,
        6,
        10,
        10,
        13,
        8,
        9,
        4,
        5,
        11,
        12,
        7,
        2,
        14,
    ),
    (
        2,
        12,
        4,
        1,
        7,
        10,
        11,
        6,
        8,
        5,
        3,
        15,
        13,
        0,
        14,
        9,
        14,
        11,
        2,
        12,
        4,
        7,
        13,
        1,
        5,
        0,
        15,
        10,
        3,
        9,
        8,
        6,
        4,
        2,
        1,
        11,
        10,
        13,
        7,
        8,
        15,
        9,
        12,
        5,
        6,
        3,
        0,
        14,
        11,
        8,
        12,
        7,
        1,
        14,
        2,
        13,
        6,
        15,
        0,
        9,
        10,
        4,
        5,
        3,
    ),
    (
        12,
        1,
        10,
        15,
        9,
        2,
        6,
        8,
        0,
        13,
        3,
        4,
        14,
        7,
        5,
        11,
        10,
        15,
        4,
        2,
        7,
        12,
        9,
        5,
        6,
        1,
        13,
        14,
        0,
        11,
        3,
        8,
        9,
        14,
        15,
        5,
        2,
        8,
        12,
        3,
        7,
        0,
        4,
        10,
        1,
        13,
        11,
        6,
        4,
        3,
        2,
        12,
        9,
        5,
        15,
        10,
        11,
        14,
        1,
        7,
        6,
        0,
        8,
        13,
    ),
    (
        4,
        11,
        2,
        14,
        15,
        0,
        8,
        13,
        3,
        12,
        9,
        7,
        5,
        10,
        6,
        1,
        13,
        0,
        11,
        7,
        4,
        9,
        1,
        10,
        14,
        3,
        5,
        12,
        2,
        15,
        8,
        6,
        1,
        4,
        11,
        13,
        12,
        3,
        7,
        14,
        10,
        15,
        6,
        8,
        0,
        5,
        9,
        2,
        6,
        11,
        13,
        8,
        1,
        4,
        10,
        7,
        9,
        5,
        0,
        15,
        14,
        2,
        3,
        12,
    ),
    (
        13,
        2,
        8,
        4,
        6,
        15,
        11,
        1,
        10,
        9,
        3,
        14,
        5,
        0,
        12,
        7,
        1,
        15,
        13,
        8,
        10,
        3,
        7,
        4,
        12,
        5,
        6,
        11,
        0,
        14,
        9,
        2,
        7,
        11,
        4,
        1,
        9,
        12,
        14,
        2,
        0,
        6,
        10,
        13,
        15,
        3,
        5,
        8,
        2,
        1,
        14,
        7,
        4,
        10,
        8,
        13,
        15,
        12,
        9,
        0,
        3,
        5,
        6,
        11,
    ),
)

KEY_RND_SHIFT = (1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1)
KEY_PERM_C = (
    56,
    48,
    40,
    32,
    24,
    16,
    8,
    0,
    57,
    49,
    41,
    33,
    25,
    17,
    9,
    1,
    58,
    50,
    42,
    34,
    26,
    18,
    10,
    2,
    59,
    51,
    43,
    35,
)
KEY_PERM_D = (
    62,
    54,
    46,
    38,
    30,
    22,
    14,
    6,
    61,
    53,
    45,
    37,
    29,
    21,
    13,
    5,
    60,
    52,
    44,
    36,
    28,
    20,
    12,
    4,
    27,
    19,
    11,
    3,
)
KEY_COMPRESSION = (
    13,
    16,
    10,
    23,
    0,
    4,
    2,
    27,
    14,
    5,
    20,
    9,
    22,
    18,
    11,
    3,
    25,
    7,
    15,
    6,
    26,
    19,
    12,
    1,
    40,
    51,
    30,
    36,
    46,
    54,
    29,
    39,
    50,
    44,
    32,
    47,
    43,
    48,
    38,
    55,
    33,
    52,
    45,
    41,
    49,
    35,
    28,
    31,
)

# QRC 固定密钥：!@#)(*$%123ZXC!@!@#)(NHL
QRC_KEY = bytes(
    (
        0x21,
        0x40,
        0x23,
        0x29,
        0x28,
        0x2A,
        0x24,
        0x25,
        0x31,
        0x32,
        0x33,
        0x5A,
        0x58,
        0x43,
        0x21,
        0x40,
        0x21,
        0x40,
        0x23,
        0x29,
        0x28,
        0x4E,
        0x48,
        0x4C,
    )
)

Schedule = list[bytearray]


def _bitnum(buf: bytes, bit: int, shift: int) -> int:
    """按 64 位大端位序取 buf 的第 bit 位（bit: 0=MSB），左移 shift。"""
    index = (bit // 32) * 4 + 3 - ((bit % 32) // 8)
    return (((buf[index] >> (7 - (bit % 8))) & 1) << shift) & _MASK32


def _bitnum_intr(value: int, bit: int, shift: int) -> int:
    return (((value >> (31 - bit)) & 1) << shift) & _MASK32


def _bitnum_intl(value: int, bit: int, shift: int) -> int:
    return (((value << bit) & 0x80000000) & _MASK32) >> shift


def _sbox_bit(value: int) -> int:
    return (value & 32) | ((value & 31) >> 1) | ((value & 1) << 4)


def _initial_permutation(block: bytes) -> tuple[int, int]:
    s0 = (
        _bitnum(block, 57, 31)
        | _bitnum(block, 49, 30)
        | _bitnum(block, 41, 29)
        | _bitnum(block, 33, 28)
        | _bitnum(block, 25, 27)
        | _bitnum(block, 17, 26)
        | _bitnum(block, 9, 25)
        | _bitnum(block, 1, 24)
        | _bitnum(block, 59, 23)
        | _bitnum(block, 51, 22)
        | _bitnum(block, 43, 21)
        | _bitnum(block, 35, 20)
        | _bitnum(block, 27, 19)
        | _bitnum(block, 19, 18)
        | _bitnum(block, 11, 17)
        | _bitnum(block, 3, 16)
        | _bitnum(block, 61, 15)
        | _bitnum(block, 53, 14)
        | _bitnum(block, 45, 13)
        | _bitnum(block, 37, 12)
        | _bitnum(block, 29, 11)
        | _bitnum(block, 21, 10)
        | _bitnum(block, 13, 9)
        | _bitnum(block, 5, 8)
        | _bitnum(block, 63, 7)
        | _bitnum(block, 55, 6)
        | _bitnum(block, 47, 5)
        | _bitnum(block, 39, 4)
        | _bitnum(block, 31, 3)
        | _bitnum(block, 23, 2)
        | _bitnum(block, 15, 1)
        | _bitnum(block, 7, 0)
    ) & _MASK32
    s1 = (
        _bitnum(block, 56, 31)
        | _bitnum(block, 48, 30)
        | _bitnum(block, 40, 29)
        | _bitnum(block, 32, 28)
        | _bitnum(block, 24, 27)
        | _bitnum(block, 16, 26)
        | _bitnum(block, 8, 25)
        | _bitnum(block, 0, 24)
        | _bitnum(block, 58, 23)
        | _bitnum(block, 50, 22)
        | _bitnum(block, 42, 21)
        | _bitnum(block, 34, 20)
        | _bitnum(block, 26, 19)
        | _bitnum(block, 18, 18)
        | _bitnum(block, 10, 17)
        | _bitnum(block, 2, 16)
        | _bitnum(block, 60, 15)
        | _bitnum(block, 52, 14)
        | _bitnum(block, 44, 13)
        | _bitnum(block, 36, 12)
        | _bitnum(block, 28, 11)
        | _bitnum(block, 20, 10)
        | _bitnum(block, 12, 9)
        | _bitnum(block, 4, 8)
        | _bitnum(block, 62, 7)
        | _bitnum(block, 54, 6)
        | _bitnum(block, 46, 5)
        | _bitnum(block, 38, 4)
        | _bitnum(block, 30, 3)
        | _bitnum(block, 22, 2)
        | _bitnum(block, 14, 1)
        | _bitnum(block, 6, 0)
    ) & _MASK32
    return s0, s1


def _inverse_permutation(s0: int, s1: int, out: bytearray) -> None:
    out[3] = (
        _bitnum_intr(s1, 7, 7)
        | _bitnum_intr(s0, 7, 6)
        | _bitnum_intr(s1, 15, 5)
        | _bitnum_intr(s0, 15, 4)
        | _bitnum_intr(s1, 23, 3)
        | _bitnum_intr(s0, 23, 2)
        | _bitnum_intr(s1, 31, 1)
        | _bitnum_intr(s0, 31, 0)
    ) & _MASK8
    out[2] = (
        _bitnum_intr(s1, 6, 7)
        | _bitnum_intr(s0, 6, 6)
        | _bitnum_intr(s1, 14, 5)
        | _bitnum_intr(s0, 14, 4)
        | _bitnum_intr(s1, 22, 3)
        | _bitnum_intr(s0, 22, 2)
        | _bitnum_intr(s1, 30, 1)
        | _bitnum_intr(s0, 30, 0)
    ) & _MASK8
    out[1] = (
        _bitnum_intr(s1, 5, 7)
        | _bitnum_intr(s0, 5, 6)
        | _bitnum_intr(s1, 13, 5)
        | _bitnum_intr(s0, 13, 4)
        | _bitnum_intr(s1, 21, 3)
        | _bitnum_intr(s0, 21, 2)
        | _bitnum_intr(s1, 29, 1)
        | _bitnum_intr(s0, 29, 0)
    ) & _MASK8
    out[0] = (
        _bitnum_intr(s1, 4, 7)
        | _bitnum_intr(s0, 4, 6)
        | _bitnum_intr(s1, 12, 5)
        | _bitnum_intr(s0, 12, 4)
        | _bitnum_intr(s1, 20, 3)
        | _bitnum_intr(s0, 20, 2)
        | _bitnum_intr(s1, 28, 1)
        | _bitnum_intr(s0, 28, 0)
    ) & _MASK8
    out[7] = (
        _bitnum_intr(s1, 3, 7)
        | _bitnum_intr(s0, 3, 6)
        | _bitnum_intr(s1, 11, 5)
        | _bitnum_intr(s0, 11, 4)
        | _bitnum_intr(s1, 19, 3)
        | _bitnum_intr(s0, 19, 2)
        | _bitnum_intr(s1, 27, 1)
        | _bitnum_intr(s0, 27, 0)
    ) & _MASK8
    out[6] = (
        _bitnum_intr(s1, 2, 7)
        | _bitnum_intr(s0, 2, 6)
        | _bitnum_intr(s1, 10, 5)
        | _bitnum_intr(s0, 10, 4)
        | _bitnum_intr(s1, 18, 3)
        | _bitnum_intr(s0, 18, 2)
        | _bitnum_intr(s1, 26, 1)
        | _bitnum_intr(s0, 26, 0)
    ) & _MASK8
    out[5] = (
        _bitnum_intr(s1, 1, 7)
        | _bitnum_intr(s0, 1, 6)
        | _bitnum_intr(s1, 9, 5)
        | _bitnum_intr(s0, 9, 4)
        | _bitnum_intr(s1, 17, 3)
        | _bitnum_intr(s0, 17, 2)
        | _bitnum_intr(s1, 25, 1)
        | _bitnum_intr(s0, 25, 0)
    ) & _MASK8
    out[4] = (
        _bitnum_intr(s1, 0, 7)
        | _bitnum_intr(s0, 0, 6)
        | _bitnum_intr(s1, 8, 5)
        | _bitnum_intr(s0, 8, 4)
        | _bitnum_intr(s1, 16, 3)
        | _bitnum_intr(s0, 16, 2)
        | _bitnum_intr(s1, 24, 1)
        | _bitnum_intr(s0, 24, 0)
    ) & _MASK8


def _des_f(state: int, key: Sequence[int]) -> int:
    """Feistel 轮函数。"""
    t1 = (
        _bitnum_intl(state, 31, 0)
        | ((state & 0xF0000000) >> 1)
        | _bitnum_intl(state, 4, 5)
        | _bitnum_intl(state, 3, 6)
        | ((state & 0x0F000000) >> 3)
        | _bitnum_intl(state, 8, 11)
        | _bitnum_intl(state, 7, 12)
        | ((state & 0x00F00000) >> 5)
        | _bitnum_intl(state, 12, 17)
        | _bitnum_intl(state, 11, 18)
        | ((state & 0x000F0000) >> 7)
        | _bitnum_intl(state, 16, 23)
    ) & _MASK32
    t2 = (
        _bitnum_intl(state, 15, 0)
        | (((state & 0x0000F000) << 15) & _MASK32)
        | _bitnum_intl(state, 20, 5)
        | _bitnum_intl(state, 19, 6)
        | (((state & 0x00000F00) << 13) & _MASK32)
        | _bitnum_intl(state, 24, 11)
        | _bitnum_intl(state, 23, 12)
        | (((state & 0x000000F0) << 11) & _MASK32)
        | _bitnum_intl(state, 28, 17)
        | _bitnum_intl(state, 27, 18)
        | (((state & 0x0000000F) << 9) & _MASK32)
        | _bitnum_intl(state, 0, 23)
    ) & _MASK32

    lrgstate = [
        (t1 >> 24) & _MASK8,
        (t1 >> 16) & _MASK8,
        (t1 >> 8) & _MASK8,
        (t2 >> 24) & _MASK8,
        (t2 >> 16) & _MASK8,
        (t2 >> 8) & _MASK8,
    ]
    for i in range(6):
        lrgstate[i] ^= key[i]

    s = (
        (SBOX[0][_sbox_bit(lrgstate[0] >> 2)] << 28)
        | (SBOX[1][_sbox_bit(((lrgstate[0] & 0x03) << 4) | (lrgstate[1] >> 4))] << 24)
        | (SBOX[2][_sbox_bit(((lrgstate[1] & 0x0F) << 2) | (lrgstate[2] >> 6))] << 20)
        | (SBOX[3][_sbox_bit(lrgstate[2] & 0x3F)] << 16)
        | (SBOX[4][_sbox_bit(lrgstate[3] >> 2)] << 12)
        | (SBOX[5][_sbox_bit(((lrgstate[3] & 0x03) << 4) | (lrgstate[4] >> 4))] << 8)
        | (SBOX[6][_sbox_bit(((lrgstate[4] & 0x0F) << 2) | (lrgstate[5] >> 6))] << 4)
        | SBOX[7][_sbox_bit(lrgstate[5] & 0x3F)]
    ) & _MASK32

    return (
        _bitnum_intl(s, 15, 0)
        | _bitnum_intl(s, 6, 1)
        | _bitnum_intl(s, 19, 2)
        | _bitnum_intl(s, 20, 3)
        | _bitnum_intl(s, 28, 4)
        | _bitnum_intl(s, 11, 5)
        | _bitnum_intl(s, 27, 6)
        | _bitnum_intl(s, 16, 7)
        | _bitnum_intl(s, 0, 8)
        | _bitnum_intl(s, 14, 9)
        | _bitnum_intl(s, 22, 10)
        | _bitnum_intl(s, 25, 11)
        | _bitnum_intl(s, 4, 12)
        | _bitnum_intl(s, 17, 13)
        | _bitnum_intl(s, 30, 14)
        | _bitnum_intl(s, 9, 15)
        | _bitnum_intl(s, 1, 16)
        | _bitnum_intl(s, 7, 17)
        | _bitnum_intl(s, 23, 18)
        | _bitnum_intl(s, 13, 19)
        | _bitnum_intl(s, 31, 20)
        | _bitnum_intl(s, 26, 21)
        | _bitnum_intl(s, 2, 22)
        | _bitnum_intl(s, 8, 23)
        | _bitnum_intl(s, 18, 24)
        | _bitnum_intl(s, 12, 25)
        | _bitnum_intl(s, 29, 26)
        | _bitnum_intl(s, 5, 27)
        | _bitnum_intl(s, 21, 28)
        | _bitnum_intl(s, 10, 29)
        | _bitnum_intl(s, 3, 30)
        | _bitnum_intl(s, 24, 31)
    ) & _MASK32


def _des_crypt(block: bytes, schedule: Sequence[Sequence[int]], out: bytearray) -> None:
    """单次 DES 加/解密一个 8 字节分组。"""
    s0, s1 = _initial_permutation(block)
    for i in range(15):
        s0, s1 = s1, (_des_f(s1, schedule[i]) ^ s0) & _MASK32
    s0 = (_des_f(s1, schedule[15]) ^ s0) & _MASK32
    _inverse_permutation(s0, s1, out)


def _key_schedule(key: bytes, mode: int) -> Schedule:
    """生成 16 轮子密钥，每轮 6 字节。"""
    schedule = [bytearray(6) for _ in range(16)]
    c = 0
    d = 0
    for i in range(28):
        c = (c | _bitnum(key, KEY_PERM_C[i], 31 - i)) & _MASK32
        d = (d | _bitnum(key, KEY_PERM_D[i], 31 - i)) & _MASK32
    for i in range(16):
        shift = KEY_RND_SHIFT[i]
        c = (((c << shift) & _MASK32) | (c >> (28 - shift))) & 0xFFFFFFF0
        d = (((d << shift) & _MASK32) | (d >> (28 - shift))) & 0xFFFFFFF0
        togen = 15 - i if mode == DES_DECRYPT else i
        row = schedule[togen]
        for j in range(24):
            row[j // 8] |= _bitnum_intr(c, KEY_COMPRESSION[j], 7 - (j % 8))
        for j in range(24, 48):
            row[j // 8] |= _bitnum_intr(d, KEY_COMPRESSION[j] - 27, 7 - (j % 8))
    return schedule


def _tripledes_key_setup(key: bytes, mode: int) -> tuple[Schedule, Schedule, Schedule]:
    """3DES(EDE3) 密钥编排，返回 3 组 16x6 轮密钥。"""
    if mode == DES_ENCRYPT:
        return (
            _key_schedule(key[0:8], DES_ENCRYPT),
            _key_schedule(key[8:16], DES_DECRYPT),
            _key_schedule(key[16:24], DES_ENCRYPT),
        )
    return (
        _key_schedule(key[16:24], DES_DECRYPT),
        _key_schedule(key[8:16], DES_ENCRYPT),
        _key_schedule(key[0:8], DES_DECRYPT),
    )


def _tripledes_crypt(block: bytes, schedule: tuple[Schedule, Schedule, Schedule]) -> bytes:
    """3DES 加/解密一个 8 字节分组（ECB，无填充）。"""
    buf = bytearray(8)
    mid = bytearray(8)
    _des_crypt(block, schedule[0], buf)
    _des_crypt(bytes(buf), schedule[1], mid)
    _des_crypt(bytes(mid), schedule[2], buf)
    return bytes(buf)


def _inflate(data: bytes) -> bytes:
    """zlib 解压，容忍尾部不完整/多余字节（对应原实现的 Z_SYNC_FLUSH）。"""
    try:
        return zlib.decompress(data)
    except zlib.error:
        pass

    # 流未正常收尾（3DES 分组补位会在尾部留垃圾）时，flush 报错属预期，已解出的部分仍可用
    for wbits in (15, 15 + 32, -15):
        try:
            decompressor = zlib.decompressobj(wbits)
            out = decompressor.decompress(data)
        except zlib.error:
            continue
        try:
            out += decompressor.flush()
        except zlib.error:
            pass
        if out:
            return out

    # 帧中间损坏时逐块喂入，保住出错点之前已解出的前缀
    for wbits in (15, 15 + 32, -15):
        try:
            decompressor = zlib.decompressobj(wbits)
        except zlib.error:
            continue
        out = bytearray()
        try:
            for offset in range(0, len(data), 64):
                out += decompressor.decompress(data[offset : offset + 64])
            out += decompressor.flush()
        except zlib.error:
            if out:
                return bytes(out)
            continue
        if out:
            return bytes(out)
    return b""


def decode_qrc(hex_data: str | None) -> str:
    """解密腾讯 QRC 歌词。

    :param hex_data: 服务端返回的十六进制字符串
    :return: 解密并解压后的歌词文本（解析失败时返回空字符串）
    """
    if not hex_data or len(hex_data) % 2 != 0:
        return ""
    try:
        encrypted = bytes.fromhex(hex_data)
    except ValueError:
        return ""
    if not encrypted:
        return ""

    schedule = _tripledes_key_setup(QRC_KEY, DES_DECRYPT)

    plain = bytearray()
    for offset in range(0, len(encrypted) - 7, 8):
        plain += _tripledes_crypt(encrypted[offset : offset + 8], schedule)

    # 尾部不足 8 字节的分组原样保留（inflate 只看有效部分，与原文 set 不上剩余块一致）
    plain += encrypted[len(plain) :]

    return _inflate(bytes(plain)).decode("utf-8", errors="replace")
