"""酷我评论（对应 sdk/kw/comment.ts）。

`ncomment.kuwo.cn/com.s` 只认安卓 Dalvik UA；`type=get_comment` 取最新评论、
`type=get_rec_comment` 取热评，两者响应字段名不同（comments/comments_counts
vs hot_comments/hot_comments_counts）。
"""

from __future__ import annotations

import math
from typing import Any
from urllib.parse import unquote

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import date_format2

COMMENT_API = (
    "http://ncomment.kuwo.cn/com.s?f=web&type={type}&aapiver=1&prod=kwplayer_ar_10.5.2.0"
    "&digest=15&sid={songmid}&start={start}&msgflag=1&count={count}&newver=3&uid=0"
)

HEADERS = {"User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9;)"}


def _to_int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _reply_comment(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item.get("id"),
        "text": item.get("msg"),
        "time": item.get("time"),
        "timeStr": date_format2(_to_int(item.get("time")) * 1000),
        "userName": item.get("u_name"),
        "avatar": item.get("u_pic"),
        "userId": item.get("u_id"),
        "likedCount": item.get("like_num"),
        "images": [item["mpic"]] if item.get("mpic") else [],
    }


def _filter_comment(raw_list: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not raw_list:
        return []
    result: list[dict[str, Any]] = []
    for item in raw_list:
        data = _reply_comment(item)
        data["images"] = [unquote(str(item["mpic"]))] if item.get("mpic") else []
        # 顶层评论多一个楼中楼数组；原实现对父级 mpic 做 decodeURIComponent，子级不做
        data["reply"] = [_reply_comment(child) for child in item.get("child_comments") or []]
        result.append(data)
    return result


async def _get_comment(songmid: str, page: int, limit: int, *, hot: bool) -> dict[str, Any]:
    comment_type = "get_rec_comment" if hot else "get_comment"
    url = COMMENT_API.format(type=comment_type, songmid=songmid, start=limit * (page - 1), count=limit)
    resp = await http_fetch(url, headers=HEADERS)
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or str(body.get("code")) != "200":
        raise RuntimeError("获取热门评论失败" if hot else "获取评论失败")

    if hot:
        total = _to_int(body.get("hot_comments_counts"))
        comments = _filter_comment(body.get("hot_comments"))
    else:
        total = _to_int(body.get("comments_counts"))
        comments = _filter_comment(body.get("comments"))
    return {
        "source": "kw",
        "comments": comments,
        "total": total,
        "page": page,
        "limit": limit,
        # 原实现用 `Math.ceil(total/limit) || 1` 兜住 0 条
        "maxPage": math.ceil(total / limit) if limit and total else 1,
    }


async def get_comment(song_info: dict[str, Any], page: int = 1, limit: int = 20) -> dict[str, Any]:
    return await _get_comment(str(song_info.get("songmid") or ""), page, limit, hot=False)


async def get_hot_comment(song_info: dict[str, Any], page: int = 1, limit: int = 100) -> dict[str, Any]:
    return await _get_comment(str(song_info.get("songmid") or ""), page, limit, hot=True)
