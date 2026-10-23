"""QQ音乐评论（移植自 sdk/tx/comment.ts）。

两路数据源（与原文一致，接口不同、返回形状不同）：
  * 最新评论 —— c.y.qq.com 的 fcg_global_comment_h5（form 表单，cmd=8）
  * 热门评论 —— musicu.fcg 的 music.globalComment.CommentRead/GetHotCommentList

原文靠 `_requestObj.cancelHttp()` 做并发去重；Python 请求层没有取消句柄（见
common/request.py 的说明），这里改用 asyncio.Task 合并同一 songmid 的并发查询。

两处刻意的降级/容错：
  * `middlecommentcontent` 的父评论头像与点赞数会被搬到第一条楼中楼，父条目置 null，
    随后楼中楼整体反转 —— 照抄原文，否则前端展示顺序与字段归属会和 TS 版不一致；
  * 原文 `c.replynick.substring(1)` 在 replynick 缺失时会抛 TypeError 把整页打挂，
    这里按空串处理（唯一的偏离，只影响脏数据）。
"""

from __future__ import annotations

import asyncio
import math
import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import date_format2
from app.sdk.platforms.tx.music_info import get_music_info_by_mid
from app.sdk.platforms.tx.utils import MUSICU_URL

EMOJIS: dict[str, str] = {
    "e400846": "😘",
    "e400874": "😴",
    "e400825": "😃",
    "e400847": "😙",
    "e400835": "😍",
    "e400873": "😳",
    "e400836": "😎",
    "e400867": "😭",
    "e400832": "😊",
    "e400837": "😏",
    "e400875": "😫",
    "e400831": "😉",
    "e400855": "😡",
    "e400823": "😄",
    "e400862": "😨",
    "e400844": "😖",
    "e400841": "😓",
    "e400830": "😈",
    "e400828": "😆",
    "e400833": "😋",
    "e400822": "😀",
    "e400843": "😕",
    "e400829": "😇",
    "e400824": "😂",
    "e400834": "😌",
    "e400877": "😷",
    "e400132": "🍉",
    "e400181": "🍺",
    "e401067": "☕️",
    "e400186": "🥧",
    "e400343": "🐷",
    "e400116": "🌹",
    "e400126": "🍃",
    "e400613": "💋",
    "e401236": "❤️",
    "e400622": "💔",
    "e400637": "💣",
    "e400643": "💩",
    "e400773": "🔪",
    "e400102": "🌛",
    "e401328": "🌞",
    "e400420": "👏",
    "e400914": "🙌",
    "e400408": "👍",
    "e400414": "👎",
    "e401121": "✋",
    "e400396": "👋",
    "e400384": "👉",
    "e401115": "✊",
    "e400402": "👌",
    "e400905": "🙈",
    "e400906": "🙉",
    "e400907": "🙊",
    "e400562": "👻",
    "e400932": "🙏",
    "e400644": "💪",
    "e400611": "💉",
    "e400185": "🎁",
    "e400655": "💰",
    "e400325": "🐥",
    "e400612": "💊",
    "e400198": "🎉",
    "e401685": "⚡️",
    "e400631": "💝",
    "e400768": "🔥",
    "e400432": "👑",
}

_UA_IE = "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)"
_UA_HOT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.0.0"
)

_NEW_COMMENT_URL = "http://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg"
_EMOJI_RE = re.compile(r"\[em\](e\d+)\[/em\]")

# songmid → songId，以及并发查询合并用的 task 表
_song_id_map: dict[str, Any] = {}
_promises: dict[str, asyncio.Task[Any]] = {}


def replace_emoji(msg: str) -> str:
    """`[em]e400846[/em]` → emoji；未知编号替换为空串（与原文 `|| ''` 一致）。"""
    if not msg or "[em]" not in msg:
        return msg
    return _EMOJI_RE.sub(lambda match: EMOJIS.get(match.group(1), ""), msg)


def format_time(time: Any) -> int | None:
    """原文字符串长度 < 10 视为无效时间返回 null；否则补 `000` 转毫秒。"""
    text = str(time)
    if len(text) < 10:
        return None
    try:
        return int(text + "000")
    except ValueError:
        return None


async def get_song_id(song_info: dict[str, Any]) -> Any:
    """songId 优先；否则 songmid 反查（带缓存 + 并发合并）。"""
    song_id = song_info.get("songId")
    if song_id:
        return song_id
    songmid = str(song_info.get("songmid") or "")
    if songmid in _song_id_map:
        return _song_id_map[songmid]

    task = _promises.get(songmid)
    if task is None:
        task = asyncio.ensure_future(get_music_info_by_mid(songmid))
        _promises[songmid] = task
    try:
        info = await asyncio.shield(task)
    finally:
        _promises.pop(songmid, None)
    if not info:
        raise RuntimeError("获取歌曲信息失败")
    _song_id_map[songmid] = info.get("songId")
    return info.get("songId")


def _time_pair(time: Any) -> tuple[int | None, str | None]:
    parsed = format_time(time)
    return parsed, (date_format2(parsed) if parsed else None)


def filter_new_comment(raw_list: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in raw_list or []:
        if not isinstance(item, dict):
            continue
        time, time_str = _time_pair(item.get("time"))
        middle = item.get("middlecommentcontent")
        if middle:
            # 父条目头像/点赞搬到第一条楼中楼，父条目置空，楼中楼反转（照抄原文）
            first = middle[0]
            first["avatarurl"] = item.get("avatarurl")
            first["praisenum"] = item.get("praisenum")
            item["avatarurl"] = None
            item["praisenum"] = None
            middle.reverse()

        replies: list[dict[str, Any]] = []
        for reply in middle or []:
            if not isinstance(reply, dict):
                continue
            reply_time = time if reply.get("subcommentid") == item.get("commentid") else None
            reply_time_str = time_str if reply.get("subcommentid") == item.get("commentid") else None
            replies.append(
                {
                    "id": f"sub_{item.get('rootcommentid')}_{reply.get('subcommentid')}",
                    "text": replace_emoji(str(reply.get("subcommentcontent") or "")).replace("\\n", "\n"),
                    "time": reply_time,
                    "timeStr": reply_time_str,
                    "userName": str(reply.get("replynick") or "")[1:],
                    "avatar": reply.get("avatarurl"),
                    "userId": reply.get("encrypt_replyuin"),
                    "likedCount": reply.get("praisenum"),
                }
            )

        same_root = item.get("rootcommentid") == item.get("commentid")
        rows.append(
            {
                "id": f"{item.get('rootcommentid')}_{item.get('commentid')}",
                "rootId": item.get("rootcommentid"),
                "text": replace_emoji(str(item.get("rootcommentcontent") or "")).replace("\\n", "\n")
                if item.get("rootcommentcontent")
                else "",
                "time": time if same_root else None,
                "timeStr": time_str if same_root else None,
                "userName": str(item.get("rootcommentnick") or "")[1:],
                "avatar": item.get("avatarurl"),
                "userId": item.get("encrypt_rootcommentuin"),
                "likedCount": item.get("praisenum"),
                "reply": replies,
            }
        )
    return rows


def filter_hot_comment(raw_list: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in raw_list or []:
        if not isinstance(item, dict):
            continue
        time, time_str = _time_pair(item.get("PubTime")) if item.get("PubTime") else (None, None)
        replies: list[dict[str, Any]] = []
        for reply in item.get("SubComments") or []:
            if not isinstance(reply, dict):
                continue
            reply_time, reply_time_str = _time_pair(reply.get("PubTime")) if reply.get("PubTime") else (None, None)
            replies.append(
                {
                    "id": f"sub_{reply.get('SeqNo')}_{reply.get('CmId')}",
                    "text": replace_emoji(str(reply.get("Content") or "")).replace("\\n", "\n"),
                    "time": reply_time,
                    "timeStr": reply_time_str,
                    "userName": reply.get("Nick") or "",
                    "avatar": reply.get("Avatar"),
                    "images": [reply["Pic"]] if reply.get("Pic") else [],
                    "userId": reply.get("EncryptUin"),
                    "likedCount": reply.get("PraiseNum"),
                }
            )
        rows.append(
            {
                "id": f"{item.get('SeqNo')}_{item.get('CmId')}",
                "rootId": item.get("SeqNo"),
                "text": replace_emoji(str(item.get("Content") or "")).replace("\\n", "\n")
                if item.get("Content")
                else "",
                "time": time,
                "timeStr": time_str,
                "userName": item.get("Nick") or "",
                "images": [item["Pic"]] if item.get("Pic") else [],
                "avatar": item.get("Avatar"),
                "location": item.get("Location") or "",
                "userId": item.get("EncryptUin"),
                "likedCount": item.get("PraiseNum"),
                "reply": replies,
            }
        )
    return rows


async def get_comment(song_info: dict[str, Any], page: int = 1, limit: int = 20) -> dict[str, Any]:
    """最新评论（fcg_global_comment_h5，form 表单）。失败文案与原文一致：`获取评论失败`。"""
    song_id = await get_song_id(song_info)
    resp = await http_fetch(
        _NEW_COMMENT_URL,
        method="POST",
        headers={"User-Agent": _UA_IE},
        form={
            "uin": "0",
            "format": "json",
            "cid": "205360772",
            "reqtype": "2",
            "biztype": "1",
            "topid": song_id,
            "cmd": "8",
            "needmusiccrit": "1",
            "pagenum": page - 1,
            "pagesize": limit,
        },
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 0:
        raise RuntimeError("获取评论失败")
    comment = body.get("comment") or {}
    total = comment.get("commenttotal") or 0
    return {
        "source": "tx",
        "comments": filter_new_comment(comment.get("commentlist")),
        "total": total,
        "page": page,
        "limit": limit,
        "maxPage": math.ceil(total / limit) if limit else 1,
    }


async def get_hot_comment(song_info: dict[str, Any], page: int = 1, limit: int = 20) -> dict[str, Any]:
    """热门评论（musicu.fcg GetHotCommentList）。失败文案：`获取热门评论失败`。"""
    song_id = await get_song_id(song_info)
    resp = await http_fetch(
        MUSICU_URL,
        method="POST",
        body={
            "comm": {
                "cv": 4747474,
                "ct": 24,
                "format": "json",
                "inCharset": "utf-8",
                "outCharset": "utf-8",
                "notice": 0,
                "platform": "yqq.json",
                "needNewCode": 1,
                "uin": 0,
            },
            "req": {
                "module": "music.globalComment.CommentRead",
                "method": "GetHotCommentList",
                "param": {
                    "BizType": 1,
                    "BizId": str(song_id),
                    "LastCommentSeqNo": "",
                    "PageSize": limit,
                    "PageNum": page - 1,
                    "HotType": 1,
                    "WithAirborne": 0,
                    "PicEnable": 1,
                },
            },
        },
        headers={"User-Agent": _UA_HOT, "referer": "https://y.qq.com/", "origin": "https://y.qq.com"},
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    req = body.get("req") or {}
    if resp.status_code != 200 or body.get("code") != 0 or req.get("code") != 0:
        raise RuntimeError("获取热门评论失败")
    comment = (req.get("data") or {}).get("CommentList") or {}
    total = comment.get("Total") or 0
    return {
        "source": "tx",
        "comments": filter_hot_comment(comment.get("Comments")),
        "total": total,
        "page": page,
        "limit": limit,
        "maxPage": math.ceil(total / limit) if limit else 1,
    }
