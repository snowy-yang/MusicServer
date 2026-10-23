"""酷狗评论（对应 sdk/kg/comment.ts）。

签名：`signatureParams(params)` —— 参数串按键排序拼接后以 android 盐包裹取 MD5。
返回形状是 `{source, comments, total, page, limit, maxPage}`（不是 `list`），
`filterComment` 还要处理 `atlist` 替换与 `pcontent`（楼中楼）两种形态。
"""

from __future__ import annotations

import math
import time
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import date_format2, decode_name
from app.sdk.platforms.kg.util import signature_params

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/107.0.0.0 Safari/537.36 Edg/107.0.1418.24"
)


def _comment_params(hash_value: str, page: int, limit: int) -> str:
    return (
        "dfid=0&mid=16249512204336365674023395779019"
        f"&clienttime={int(time.time() * 1000)}&uuid=0&extdata={hash_value}"
        "&appid=1005&code=fc4be23b4e972707f36b8a828a93ba8a"
        f"&schash={hash_value}&clientver=11409&p={page}&clienttoken=&pagesize={limit}"
        "&ver=10&kugouid=0"
    )


def _replace_at(raw: str, at_list: list[dict[str, Any]]) -> str:
    for item in at_list:
        raw = raw.replace(f"[at={item.get('id')}]", f"@{item.get('name')} ")
    return raw


def _format_comment(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in raw_list:
        content = item.get("content") or ""
        if item.get("atlist"):
            content = _replace_at(str(content), item["atlist"])
        images = [image.get("url") for image in item.get("images") or []] if item.get("images") else []
        like = item.get("like") or {}
        data = {
            "id": item.get("id"),
            "text": decode_name(content),
            "images": images,
            "location": item.get("location"),
            "time": item.get("addtime"),
            "timeStr": date_format2(item.get("addtime") or 0),
            "userName": item.get("user_name"),
            "avatar": item.get("user_pic"),
            "userId": item.get("user_id"),
            "likedCount": like.get("likenum"),
            "replyNum": item.get("reply_num"),
            "reply": [],
        }
        if item.get("pcontent"):
            # 楼中楼：父评论包一层，原评论挂在 reply 里
            result.append(
                {
                    "id": item.get("id"),
                    "text": decode_name(item["pcontent"]),
                    "time": None,
                    "userName": item.get("puser"),
                    "avatar": None,
                    "userId": item.get("puser_id"),
                    "likedCount": None,
                    "replyNum": None,
                    "reply": [data],
                }
            )
        else:
            result.append(data)
    return result


async def _get_comment(hash_value: str, page: int, limit: int, hot: bool) -> dict[str, Any]:
    path = "topliked" if hot else "newest"
    params = _comment_params(hash_value, page, limit)
    resp = await http_fetch(
        f"http://m.comment.service.kugou.com/r/v1/rank/{path}?{params}&signature={signature_params(params)}",
        headers={"User-Agent": _UA},
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("err_code") != 0:
        raise RuntimeError("获取热门评论失败" if hot else "获取评论失败")
    total = body.get("count") or 0
    return {
        "source": "kg",
        "comments": _format_comment(body.get("list") or []),
        "total": total,
        "page": page,
        "limit": limit,
        "maxPage": math.ceil(total / limit) if limit else 1,
    }


async def get_comment(song_info: dict[str, Any], page: int = 1, limit: int = 20) -> dict[str, Any]:
    hash_value = str(song_info.get("hash") or song_info.get("songmid") or "")
    return await _get_comment(hash_value, page, limit, False)


async def get_hot_comment(song_info: dict[str, Any], page: int = 1, limit: int = 20) -> dict[str, Any]:
    hash_value = str(song_info.get("hash") or song_info.get("songmid") or "")
    return await _get_comment(hash_value, page, limit, True)


async def get_reply_comment(
    song_info: dict[str, Any], reply_id: Any, page: int = 1, limit: int = 100
) -> dict[str, Any]:
    songmid = str(song_info.get("songmid") or "")
    children_id = str(song_info.get("audioId") or "").split("_")[0] if len(songmid) == 32 else songmid
    resp = await http_fetch(
        "http://comment.service.kugou.com/index.php?r=commentsv2/getReplyWithLike"
        "&code=fc4be23b4e972707f36b8a828a93ba8a"
        f"&p={page}&pagesize={limit}&ver=1.01&clientver=8373&kugouid=687373022&need_show_image=1"
        f"&appid=1001&childrenid={children_id}&tid={reply_id}",
        headers={"User-Agent": "Android712-AndroidPhone-8983-18-0-COMMENT-wifi"},
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("err_code") != 0:
        raise RuntimeError("获取回复评论失败")
    return {"source": "kg", "comments": _format_comment(body.get("list") or [])}
