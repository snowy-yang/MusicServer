"""蜻蜓FM URL 获取（对应 sdk/apis/qt.ts，点播 audiostream 签名直链）。

链路（官网 main.js 逆向，2026-10-02 实测）：
  GET https://audio.qtfm.cn/audiostream/redirect/<channel>/<program>?access_token=&device_id=MOBILESITE&qingting_id=&t=<ms>&sign=<hex>
  sign = HMAC-MD5("7l8CZ)SgZgM_bkrw", path+query) —— 签名内容含完整 path 与 query（sign 自身除外）
  匿名空 token 即可取免费节目；响应 302 到华为云签名 CDN（vohwod-sign.qtfm.cn，m4a/mp3）
  直播电台另有 /live/<cid>/64k.mp3 + HMAC-MD5("Lwrpu$K5oP") 签名（lhttp-hw.qtfm.cn）

songmid 为复合 id ``<channelId>:<programId>``（/album/qt 列表产出）。
"""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any

SIGN_KEY = b"7l8CZ)SgZgM_bkrw"
AUDIO_HOST = "https://audio.qtfm.cn"

SUPPORT_QUALITYS: list[str] = ["64k", "128k"]


def build_program_url(channel_id: str, program_id: str) -> str:
    path = (
        f"/audiostream/redirect/{channel_id}/{program_id}"
        f"?access_token=&device_id=MOBILESITE&qingting_id=&t={int(time.time() * 1000)}"
    )
    sign = hmac.new(SIGN_KEY, path.encode(), hashlib.md5).hexdigest()
    return f"{AUDIO_HOST}{path}&sign={sign}"


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    del retry_num  # 契约参数；直链由签名即时生成，无需请求上游
    songmid = str(song_info.get("songmid") or "")
    parts = songmid.split(":")
    channel_id = parts[0] if parts else ""
    program_id = parts[1] if len(parts) > 1 else ""
    if not channel_id or not program_id:
        raise RuntimeError("蜻蜓 id 需为 <channelId>:<programId>（见 /album/qt 节目列表）")
    return {"type": "128k" if quality == "128k" else "64k", "url": build_program_url(channel_id, program_id)}
