"""酷我歌词解码（对应 sdk/kw/lyricDecode.ts）。

响应体前缀是 `tp=content`，`\\r\\n\\r\\n` 之后为 zlib 压缩数据；非 lrcx（普通歌词）
直接按 gb18030 解码，lrcx（逐字歌词）先 base64 解出、再与 `yeelion` 逐字节异或，
最后按 gb18030 解码。算法来源为酷我桌面端歌词解码实现。
"""

from __future__ import annotations

import base64
import zlib

_BUF_KEY = b"yeelion"


def _xor_yeelion(data: bytes) -> bytes:
    """逐字节与 `yeelion` 循环异或（原实现用双层 while，等价于 i % len(key)）。"""
    return bytes(byte ^ _BUF_KEY[index % len(_BUF_KEY)] for index, byte in enumerate(data))


async def decode_kw_lyric(buf: bytes, is_get_lyricx: bool) -> str:
    """解出明文歌词。非酷我歌词格式返回空串（与原实现一致）。"""
    if buf[:10].decode("utf-8", errors="replace") != "tp=content":
        return ""
    # 找不到分隔时原实现 indexOf 返回 -1，+4 后从第 3 字节开始切片，这里保持一致
    lrc_data = zlib.decompress(buf[buf.find(b"\r\n\r\n") + 4 :])

    if not is_get_lyricx:
        return lrc_data.decode("gb18030", errors="replace")

    raw = base64.b64decode(lrc_data.decode("utf-8", errors="replace"))
    return _xor_yeelion(raw).decode("gb18030", errors="replace")


async def handle_kw_decode_lyric(lrc_base64: str, is_get_lyricx: bool) -> str:
    """解码入口：入参与返回值都是 base64（对应原 handleKwDecodeLyric）。"""
    lrc = await decode_kw_lyric(base64.b64decode(lrc_base64), is_get_lyricx)
    return base64.b64encode(lrc.encode()).decode()
