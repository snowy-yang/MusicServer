"""酷我音乐 取流（对应 sdk/apis/kw.ts）。

双通道，按优先级：
  1) mobi.s convert_url_with_sign（主通道，匿名可用）
     `source=kwplayer_ar_8.5.5.0_apk_keluze.apk` + `user=0` 即可匿名拿到真音频，
     但请求档位缺失时会**静默换档**（实测 rid=440613 请求 4000kflac 回的是
     bitrate=20501 / format=mflac 的加密流，不可播），因此必须严格校验
     「返回 bitrate 精确等于请求档位」且「format 在明文白名单内」，
     任一不满足视为未命中、沿降级链换档重试。
  2) www.kuwo.cn/api/v1/www/music/playUrl（回退通道，web 端官方接口，需 Secret 签名头）
     签名所需 cookie（`Hm_Iuvt_*`，名字与值均随机下发）必须现场访问首页动态获取；
     写死 token 一律返回 `The request is illegal!`（已实测确认）。
     匿名该接口恒回 128k MP3，是 mobi 通道网络故障时的兜底。

CDN 返回的 URL query 用 `$` 顶替 `=`（`?bitrate$320&format$mp3&…&loginUid$`），
非标准分隔符播放器不认，统一还原成 `=` 再对外返回。
"""

from __future__ import annotations

import asyncio
import re
import uuid
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.kw.util import (
    HOME_URL,
    MOBI_UA,
    UA,
    fetch_home_set_cookie,
    random_digits,
)

SUPPORT_QUALITYS: list[str] = ["128k", "320k", "flac", "flac24bit"]

# 音质 → mobi.s 请求档位（bitrate 是响应必须精确命中的数值）
QUALITY_TIERS: dict[str, dict[str, Any]] = {
    "128k": {"br": "128kmp3", "bitrate": 128},
    "320k": {"br": "320kmp3", "bitrate": 320},
    "flac": {"br": "2000kflac", "bitrate": 2000},
    "flac24bit": {"br": "4000kflac", "bitrate": 4000},
}

# 档位缺失时的降级链（请求档位 → 逐级尝试）
FALLBACK_CHAIN: dict[str, list[str]] = {
    "flac24bit": ["flac", "320k", "128k"],
    "flac": ["320k", "128k"],
    "320k": ["128k"],
    "128k": [],
}

# 明文音频格式白名单；mgg/mflac/mmp4/zp 是加密格式，拿到也不能播
PLAIN_FORMATS = frozenset({"mp3", "flac", "ogg", "aac", "m4a"})

MOBI_API = "http://mobi.kuwo.cn/mobi.s"
PLAY_URL_API = "https://www.kuwo.cn/api/v1/www/music/playUrl"

_TOKEN_NAME_RE = re.compile(r"^Hm_Iuvt_\w+$")
_ILLEGAL_RE = re.compile(r"illegal", re.IGNORECASE)


def normalize_url(url: str) -> str:
    return url.replace("$", "=")


async def get_url_by_mobi(songmid: str, tier: dict[str, Any]) -> str | None:
    """mobi.s 取流：未命中（无 url / bitrate 不符 / 加密格式 / 网络异常）返回 None，由调用方换档。"""
    url = (
        f"{MOBI_API}?f=web&user=0&source=kwplayer_ar_8.5.5.0_apk_keluze.apk"
        f"&type=convert_url_with_sign&br={tier['br']}&rid={songmid}"
    )
    try:
        resp = await http_fetch(
            url,
            method="get",
            headers={"User-Agent": MOBI_UA, "Accept-Language": "zh-CN,zh;q=0.9"},
            timeout=15_000,
        )
    except Exception:  # noqa: BLE001 — 网络失败视为本档未命中，继续降级
        return None
    body = resp.body if isinstance(resp.body, dict) else {}
    data = body.get("data") or {}
    if resp.status_code != 200 or not isinstance(data, dict) or not data.get("url"):
        return None
    raw_bitrate = data.get("bitrate")
    if not isinstance(raw_bitrate, (int, float, str)):
        return None
    try:
        bitrate = int(float(raw_bitrate))
    except (TypeError, ValueError):
        return None
    if bitrate != tier["bitrate"] or str(data.get("format")) not in PLAIN_FORMATS:
        return None
    return normalize_url(str(data["url"]))


def kw_secret(message: str, key: str) -> str:
    """酷我 web 端 Secret 头哈希：key 为 cookie 名，message 为 cookie 值。

    逐字移植自 web 端 secret.js：先把 key 的每个字符码拼成数字串，
    取 5 个固定位置的数字组成乘子，再用随机种子一起做 LCG 式的异或掩码。
    """
    digits = "".join(str(ord(ch)) for ch in key)
    step = len(digits) // 5
    multiplier = int(digits[step] + digits[2 * step] + digits[3 * step] + digits[4 * step] + digits[5 * step])
    addend = -(-len(key) // 2)  # Math.ceil(e.length / 2)
    modulus = 2**31 - 1
    if multiplier < 2:
        raise RuntimeError("酷我 Secret 哈希失败")

    seed = random_digits() % 10**8
    digits += str(seed)
    while len(digits) > 10:
        digits = str(int(digits[:10]) + int(digits[10:]))

    state = (multiplier * int(digits) + addend) % modulus
    out: list[str] = []
    for ch in message:
        mask = int(state / modulus * 255)  # 对应 Math.floor(n / c * 255)
        value = ord(ch) ^ mask
        out.append(f"{value:02x}" if value < 16 else format(value, "x"))
        state = (multiplier * state + addend) % modulus
    return "".join(out) + f"{seed:08x}"


class KwToken:
    __slots__ = ("name", "secret", "value")

    def __init__(self, name: str, value: str) -> None:
        self.name = name
        self.value = value
        self.secret = kw_secret(value, name)


_state: dict[str, Any] = {"token": None, "lock": None}


def _lock() -> asyncio.Lock:
    lock = _state["lock"]
    if lock is None:
        lock = asyncio.Lock()
        _state["lock"] = lock
    return lock


async def get_token(retry_num: int = 0) -> KwToken:
    """访问首页解析动态下发的 `Hm_Iuvt_*` cookie，生成 Secret。会话级缓存。"""
    cached: KwToken | None = _state["token"]
    if cached is not None:
        return cached
    async with _lock():
        cached = _state["token"]
        if cached is not None:
            return cached
        # 重试必须在锁内用循环完成：asyncio.Lock 不可重入，锁内递归会永久死锁。
        last_error: Exception | None = None
        for _attempt in range(max(0, retry_num), 3):
            try:
                cookies = await fetch_home_set_cookie()
            except Exception as err:  # noqa: BLE001 - 网络抖动重试，最终统一抛出
                last_error = err
                continue

            found: list[tuple[str, str]] = []
            for raw in cookies:
                name, _, rest = raw.partition("=")
                name = name.strip()
                value = rest.split(";")[0] if rest else ""
                if _TOKEN_NAME_RE.match(name) and value:
                    found.append((name, value))
            if not found:
                last_error = RuntimeError("响应中没有 Hm_Iuvt_* cookie")
                continue

            token = KwToken(found[0][0], found[0][1])
            _state["token"] = token
            return token

        detail = f": {last_error}" if last_error else ""
        raise RuntimeError(f"获取酷我token失败{detail}") from last_error


async def get_url_by_playurl(songmid: str, token: KwToken, retry_num: int = 0) -> dict[str, Any]:
    """官方 playUrl 接口（需 Secret 签名）。签名/token 失效时刷新后重试一次。"""
    url = f"{PLAY_URL_API}?mid={songmid}&type=music&httpsStatus=1&plat=web_www&from=&br=128kmp3&reqId={uuid.uuid4()}"
    resp = await http_fetch(
        url,
        method="get",
        headers={
            "Cookie": f"{token.name}={token.value}",
            "Secret": token.secret,
            "Referer": HOME_URL,
            "User-Agent": UA,
        },
        timeout=15_000,
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    msg = str(body.get("msg") or body.get("message") or "")
    data = body.get("data") or {}
    if resp.status_code != 200 or not body.get("success") or not isinstance(data, dict) or not data.get("url"):
        if retry_num == 0 and _ILLEGAL_RE.search(msg):
            _state["token"] = None
            fresh = await get_token()
            return await get_url_by_playurl(songmid, fresh, retry_num + 1)
        raise RuntimeError(msg or "获取失败")
    # 服务器无视 br 参数，匿名实际只回 128k，如实上报
    return {"type": "128k", "url": normalize_url(str(data["url"]))}


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    songmid = str(song_info.get("songmid") or "").strip()
    if not songmid:
        raise RuntimeError("缺少 songmid")

    start = quality if quality in QUALITY_TIERS else "128k"
    # 逐档尝试 mobi 通道，全未命中再回退 web playUrl（匿名 128k；VIP 歌会被明确拒绝）
    for tier_type in [start, *FALLBACK_CHAIN[start]]:
        hit = await get_url_by_mobi(songmid, QUALITY_TIERS[tier_type])
        if hit:
            return {"type": tier_type, "url": hit}

    token = await get_token()
    return await get_url_by_playurl(songmid, token)
