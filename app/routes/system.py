"""系统路由 —— 健康检查与平台能力清单。"""

from __future__ import annotations

import time
from typing import Any

from app.http.envelope import ok
from app.sdk import SUPPORTED_SOURCES, support_quality
from app.sdk.platforms._base import capability_map
from fastapi import APIRouter, Request

router = APIRouter(tags=["系统"])


@router.get(
    "/health",
    summary="健康检查",
    description="返回运行时长与已接入平台数，可用于探活与监控。",
)
async def health(request: Request) -> Any:
    started_at = getattr(request.app.state, "started_at", None) or time.time()
    return ok(
        {
            "status": "ok",
            "uptime": round(time.time() - started_at),
            "platforms": len(SUPPORTED_SOURCES),
        }
    )


@router.get(
    "/sources",
    summary="获取支持的平台",
    description="返回各平台的音质支持与能力（search/url/lyric/pic/boards/hotSearch/songList/"
    "singer/album/albumSearch/playlist/playlistSearch/playlistCategories/parse/userPlaylist）。"
    "音质为 SDK 官方直连接口的支持范围。",
)
async def sources() -> Any:
    platforms: list[dict[str, Any]] = []
    for item in SUPPORTED_SOURCES:
        module = item["module"]
        platforms.append(
            {
                "id": item["id"],
                "name": item["name"],
                "qualities": support_quality.get(item["id"], []),
                "capabilities": capability_map(module),
            }
        )
    return ok({"platforms": platforms})
