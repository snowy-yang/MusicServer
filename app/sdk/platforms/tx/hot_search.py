"""QQ音乐热搜（移植自 sdk/tx/hotSearch.ts）。

musicu.fcg 的 tencent_musicsoso_hotkey.HotkeyService/GetHotkeyForQQMusicPC。
失败文案与原文一致：`获取热搜词失败`；重试上限 3 次（try max num）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.tx.utils import MUSICU_URL


def filter_list(raw_list: Any) -> list[str]:
    return [str(item.get("query")) for item in raw_list or [] if isinstance(item, dict) and item.get("query")]


async def get_list(retry_num: int = 0) -> dict[str, Any]:
    if retry_num > 2:
        raise RuntimeError("try max num")

    resp = await http_fetch(
        MUSICU_URL,
        method="post",
        headers={"Referer": "https://y.qq.com/portal/player.html"},
        body={
            "comm": {
                "ct": "19",
                "cv": "1803",
                "guid": "0",
                "patch": "118",
                "psrf_access_token_expiresAt": 0,
                "psrf_qqaccess_token": "",
                "psrf_qqopenid": "",
                "psrf_qqunionid": "",
                "tmeAppID": "qqmusic",
                "tmeLoginType": 0,
                "uin": "0",
                "wid": "0",
            },
            "hotkey": {
                "method": "GetHotkeyForQQMusicPC",
                "module": "tencent_musicsoso_hotkey.HotkeyService",
                "param": {"search_id": "", "uin": 0},
            },
        },
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 0:
        raise RuntimeError("获取热搜词失败")
    return {"source": "tx", "list": filter_list(((body.get("hotkey") or {}).get("data") or {}).get("vec_hotkey"))}
