"""咪咕加密流 —— 票据登记与 Z3D 流式解密（对应原 src/http/mg-stream.ts + sdk/mg/util.ts 解密部分）。

统一入口为 /stream/:source/:id，source=mg 时 id 即此处签发的短票据。
不把上游 URL 塞进播放地址（path 参数限长，且 URL 含时效签名与中文路径），
票据短时有效（10 分钟，够播放器起播），进程内存储、不落盘。

Z3D 解密算法（与原始 TS 一致）：
  streamKey = MD5(AES128CBC(AndroidAppKey, ENCRYPTED_APP_CODE) + fileKey) 的大写十六进制（32 字节 ASCII）
  plain[i] = (cipher[i] - streamKey[i % 32]) & 0xFF
密文可能以 3 字节 `Z3D` 魔数开头，需先剥离；已解密的数据（音频魔数开头）原样透传。
"""

from __future__ import annotations

import hashlib
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urljoin

import aiohttp
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

TTL_SECONDS = 10 * 60
STREAM_CACHE_LIMIT = 200
MIGU_STREAM_UA = "Android_migu/7.41.13 okhttp/3.12.13"

# 咪咕 Android 客户端的 app key 与加密后的 app code（服务端下发，非机密凭据）
_ANDROID_APP_KEY = b"308202333082019c"
_ENCRYPTED_APP_CODE = bytes(
    [
        0xAE, 0xEA, 0xC7, 0x17, 0x05, 0xA6, 0x89, 0x55,
        0xA9, 0x31, 0xA6, 0xFE, 0x01, 0xE7, 0x28, 0xFF,
        0xF6, 0x49, 0x71, 0xE6, 0x1C, 0xEA, 0xF0, 0x0A,
        0xE3, 0xEA, 0x43, 0xC3, 0xE0, 0x58, 0x33, 0x83,
    ]
)  # fmt: skip
_Z3D_IV = bytes(range(16))


@dataclass
class MiguStreamTicket:
    url: str
    file_key: str
    created_at: float


_tickets: dict[str, MiguStreamTicket] = {}


def _prune() -> None:
    now = time.time()
    for key in [k for k, t in _tickets.items() if now - t.created_at > TTL_SECONDS]:
        _tickets.pop(key, None)
    # 超出容量时按插入顺序淘汰最旧票据
    while len(_tickets) > STREAM_CACHE_LIMIT:
        oldest = next(iter(_tickets), None)
        if oldest is None:
            break
        _tickets.pop(oldest, None)


def register_migu_stream(url: str, file_key: str) -> str:
    """登记一条加密流，返回可直接放入 /stream/mg/:id 的短票据 id。"""
    _prune()
    ticket_id = uuid.uuid4().hex
    _tickets[ticket_id] = MiguStreamTicket(url=url, file_key=file_key, created_at=time.time())
    return ticket_id


def take_migu_stream(ticket_id: str) -> MiguStreamTicket | None:
    """取出票据（过期返回 None）。"""
    ticket = _tickets.get(ticket_id)
    if not ticket:
        return None
    if time.time() - ticket.created_at > TTL_SECONDS:
        _tickets.pop(ticket_id, None)
        return None
    return ticket


def is_migu_audio_magic(data: bytes) -> bool:
    """判断是否明文音频：fLaC / RIFF-WAVE / OggS / ID3 / MP4(ftyp) / MP3 帧同步。"""
    if len(data) < 4:
        return False
    head4 = data[:4]
    if head4 in (b"fLaC", b"OggS"):
        return True
    if head4 == b"RIFF" and len(data) >= 12 and data[8:12] == b"WAVE":
        return True
    if data[:3] == b"ID3":
        return True
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return True
    return data[0] == 0xFF and (data[1] & 0xE0) == 0xE0


def migu_z3d_stream_key(file_key: str) -> bytes:
    """streamKey = MD5(解密后的 appCode + fileKey) 的大写十六进制（32 字节 ASCII）。"""
    key = str(file_key or "").strip()
    if not key:
        raise RuntimeError("空的 z3d fileKey")
    # Go 的 CryptBlocks 按块解密不做 PKCS#7 去填充，这里同样禁用填充，否则尾块校验失败
    decryptor = Cipher(algorithms.AES(_ANDROID_APP_KEY), modes.CBC(_Z3D_IV)).decryptor()
    app_code = decryptor.update(_ENCRYPTED_APP_CODE) + decryptor.finalize()
    digest = hashlib.md5(app_code + key.encode("utf-8")).hexdigest().upper()
    return digest.encode("ascii")


def decrypt_z3d(data: bytes, file_key: str) -> bytes:
    """整段解密（非流式场景；已是明文则原样返回）。"""
    if not data:
        raise RuntimeError("空的 z3d 数据")
    if is_migu_audio_magic(data):
        return data
    payload = data[3:] if data[:3] == b"Z3D" else data
    if not payload:
        raise RuntimeError("剥离 Z3D 魔数后无数据")
    stream_key = migu_z3d_stream_key(file_key)
    plain = bytes((byte - stream_key[index & 31]) & 0xFF for index, byte in enumerate(payload))
    if not is_migu_audio_magic(plain):
        raise RuntimeError("z3d 解密后不是有效音频")
    return plain


class Z3DStreamDecoder:
    """按块增量解密：跨块保持全局偏移，首块剥离 `Z3D` 魔数并校验结果。"""

    def __init__(self, file_key: str) -> None:
        self._stream_key = migu_z3d_stream_key(file_key)
        self._offset = 0
        self._pending = b""  # 首块不足 3 字节时暂存，用于判断 `Z3D` 魔数
        self._checked = False

    def feed(self, chunk: bytes) -> bytes:
        if not chunk:
            return b""
        data = self._pending + chunk
        self._pending = b""
        if self._offset == 0 and len(data) < 3:
            self._pending = data
            return b""
        if self._offset == 0 and data[:3] == b"Z3D":
            data = data[3:]
        base = self._offset
        self._offset += len(data)
        plain = bytes((byte - self._stream_key[(base + index) & 31]) & 0xFF for index, byte in enumerate(data))
        if not self._checked and plain:
            self._checked = True
            if not is_migu_audio_magic(plain):
                raise RuntimeError("z3d 解密后不是有效音频")
        return plain


def migu_stream_content_type(url: str) -> str:
    """按扩展名推断明文的 content-type。"""
    if ".flac" in url:
        return "audio/flac"
    if ".wav" in url:
        return "audio/wav"
    if ".m4a" in url:
        return "audio/mp4"
    return "audio/mpeg"


async def stream_decrypted(
    url: str,
    feed: Callable[[bytes], bytes],
    on_chunk: Callable[[bytes], None],
    *,
    max_redirects: int = 3,
) -> None:
    """流式下载密流并逐块解密后交给 on_chunk。

    整段音频可达上百 MB，因此按块处理而不读入内存；上游 URL 常带 302，
    这里手动跟随（默认不跟随重定向，与请求层语义一致）。
    """
    timeout = aiohttp.ClientTimeout(total=300, sock_read=60)
    headers = {"User-Agent": MIGU_STREAM_UA, "Referer": "https://music.migu.cn/"}
    current = url
    for _ in range(max_redirects + 1):
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(current, headers=headers, allow_redirects=False) as resp:
                if 300 <= resp.status < 400 and (location := resp.headers.get("location")):
                    current = urljoin(current, location)
                    continue
                if resp.status != 200:
                    raise RuntimeError(f"上游返回 {resp.status}")
                async for chunk in resp.content.iter_any():
                    plain = feed(chunk)
                    if plain:
                        on_chunk(plain)
                return
    raise RuntimeError("重定向次数过多")
