"""网易云评论（移植自 sdk/wy/comment.ts）。

网易云的评论接口是游标式（orderType + cursor + offset），不是页码式。原实现用
`cursor_tools` 缓存每首歌最近一次的游标：向后翻页用旧游标 + offset，向前翻页用 orderType=0，
重刷同一页则回退到 prevCursor。这里逐行保留该逻辑，否则翻页会跳条。

注意请求头里的 `Refere` 是原实现的拼写，上游不校验该头，保留以免引入行为差异。
"""

from __future__ import annotations

import math
import time
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import date_format2
from app.sdk.platforms.wy.utils import weapi_headers
from app.sdk.platforms.wy.utils.crypto import weapi

EMOJIS: list[tuple[str, str]] = [
    ("大笑", "😃"),
    ("可爱", "😊"),
    ("憨笑", "☺️"),
    ("色", "😍"),
    ("亲亲", "😙"),
    ("惊恐", "😱"),
    ("流泪", "😭"),
    ("亲", "😚"),
    ("呆", "😳"),
    ("哀伤", "😔"),
    ("呲牙", "😁"),
    ("吐舌", "😝"),
    ("撇嘴", "😒"),
    ("怒", "😡"),
    ("奸笑", "😏"),
    ("汗", "😓"),
    ("痛苦", "😖"),
    ("惶恐", "😰"),
    ("生病", "😨"),
    ("口罩", "😷"),
    ("大哭", "😂"),
    ("晕", "😵"),
    ("发怒", "👿"),
    ("开心", "😄"),
    ("鬼脸", "😜"),
    ("皱眉", "😞"),
    ("流感", "😢"),
    ("爱心", "❤️"),
    ("心碎", "💔"),
    ("钟情", "💘"),
    ("星星", "⭐️"),
    ("生气", "💢"),
    ("便便", "💩"),
    ("强", "👍"),
    ("弱", "👎"),
    ("拜", "🙏"),
    ("牵手", "👫"),
    ("跳舞", "👯‍♀️"),
    ("禁止", "🙅‍♀️"),
    ("这边", "💁‍♀️"),
    ("爱意", "💏"),
    ("示爱", "👩‍❤️‍👨"),
    ("嘴唇", "👄"),
    ("狗", "🐶"),
    ("猫", "🐱"),
    ("猪", "🐷"),
    ("兔子", "🐰"),
    ("小鸡", "🐤"),
    ("公鸡", "🐔"),
    ("幽灵", "👻"),
    ("圣诞", "🎅"),
    ("外星", "👽"),
    ("钻石", "💎"),
    ("礼物", "🎁"),
    ("男孩", "👦"),
    ("女孩", "👧"),
    ("蛋糕", "🎂"),
    ("18", "🔞"),
    ("圈", "⭕"),
    ("叉", "❌"),
]


def apply_emoji(text: str) -> str:
    for name, emoji in EMOJIS:
        text = text.replace(f"[{name}]", emoji)
    return text


class _CursorTools:
    """按歌曲缓存游标。原实现是模块级单例对象，这里用类实例保持同一语义。"""

    def __init__(self) -> None:
        self.cache: dict[str, dict[str, Any]] = {}

    def get_cursor(self, id_: str, page: int, limit: int) -> dict[str, Any]:
        data = self.cache.setdefault(id_, {})
        order_type: int | None = None
        cursor: int | None = None
        offset: int | None = None

        if page == 1:
            data["page"] = 1
            cursor = int(time.time() * 1000)
            data["cursor"] = cursor
            data["prevCursor"] = cursor
            order_type = 1
            offset = 0
        elif data.get("page"):
            cursor = data.get("cursor")
            if page > data["page"]:
                order_type = 1
                offset = (page - data["page"] - 1) * limit
            elif page < data["page"]:
                order_type = 0
                offset = (data["page"] - page - 1) * limit
            else:
                cursor = data.get("prevCursor")
                data["cursor"] = cursor
                offset = data.get("offset")
                order_type = data.get("orderType")

        return {"orderType": order_type, "cursor": cursor, "offset": offset}

    def set_cursor(self, id_: str, cursor: Any, order_type: Any, offset: Any, page: int) -> None:
        data = self.cache.setdefault(id_, {})
        data["prevCursor"] = data.get("cursor")
        data["cursor"] = cursor
        data["orderType"] = order_type
        data["offset"] = offset
        data["page"] = page


cursor_tools = _CursorTools()


def filter_comment(raw_list: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in raw_list or []:
        if not isinstance(item, dict):
            continue
        user = item.get("user") or {}
        raw_time = item.get("time")
        content = item.get("content")
        data = {
            "id": item.get("commentId"),
            "text": apply_emoji(str(content)) if content else "",
            "time": raw_time or "",
            "timeStr": date_format2(raw_time) if raw_time else "",
            "location": (item.get("ipLocation") or {}).get("location"),
            "userName": user.get("nickname"),
            "avatar": user.get("avatarUrl"),
            "userId": user.get("userId"),
            "likedCount": item.get("likedCount"),
            "reply": [],
        }

        replied = item.get("beReplied") or []
        reply_data = replied[0] if replied else None
        if not isinstance(reply_data, dict):
            rows.append(data)
            continue
        reply_user = reply_data.get("user") or {}
        reply_content = reply_data.get("content")
        rows.append(
            {
                "id": item.get("commentId"),
                "rootId": reply_data.get("beRepliedCommentId"),
                "text": apply_emoji(str(reply_content)) if reply_content else "",
                "time": item.get("time"),
                "timeStr": None,
                "location": (reply_data.get("ipLocation") or {}).get("location"),
                "userName": reply_user.get("nickname"),
                "avatar": reply_user.get("avatarUrl"),
                "userId": reply_user.get("userId"),
                "likedCount": None,
                "reply": [data],
            }
        )
    return rows


def _max_page(total: int, limit: int) -> int:
    return math.ceil(total / limit) if limit else 1


async def get_comment(song_info: dict[str, Any], page: int = 1, limit: int = 20) -> dict[str, Any]:
    """歌曲评论。失败文案与原文一致：获取评论失败。"""
    song_mid = str(song_info.get("songmid"))
    rid = f"R_SO_4_{song_mid}"
    cursor_info = cursor_tools.get_cursor(song_mid, page, limit)

    resp = await http_fetch(
        "https://music.163.com/weapi/comment/resource/comments/get",
        method="post",
        headers=weapi_headers(with_cookie=False),
        form=weapi(
            {
                "cursor": cursor_info["cursor"],
                "offset": cursor_info["offset"],
                "orderType": cursor_info["orderType"],
                "pageNo": page,
                "pageSize": limit,
                "rid": rid,
                "threadId": rid,
            }
        ),
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 200:
        raise RuntimeError("获取评论失败")

    data = body.get("data") or {}
    cursor_tools.set_cursor(song_mid, data.get("cursor"), cursor_info["orderType"], cursor_info["offset"], page)
    total = int(data.get("totalCount") or 0)
    return {
        "source": "wy",
        "comments": filter_comment(data.get("comments")),
        "total": data.get("totalCount"),
        "page": page,
        "limit": limit,
        "maxPage": _max_page(total, limit) or 1,
    }


async def get_hot_comment(song_info: dict[str, Any], page: int = 1, limit: int = 100) -> dict[str, Any]:
    """热门评论。失败文案与原文一致：获取热门评论失败。"""
    song_mid = str(song_info.get("songmid"))
    rid = f"R_SO_4_{song_mid}"
    page = page - 1

    resp = await http_fetch(
        f"https://music.163.com/weapi/v1/resource/hotcomments/{rid}",
        method="post",
        headers=weapi_headers(with_cookie=False),
        form=weapi(
            {
                "rid": rid,
                "limit": limit,
                "offset": limit * page,
                "beforeTime": str(int(time.time() * 1000)),
            }
        ),
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 200:
        raise RuntimeError("获取热门评论失败")

    total = int(body.get("total") or 0)
    return {
        "source": "wy",
        "comments": filter_comment(body.get("hotComments")),
        "total": total,
        "page": page,
        "limit": limit,
        "maxPage": _max_page(total, limit) or 1,
    }
