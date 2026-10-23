"""登录态自动续期 —— 启动后延时刷一轮 + 每 24h 一次（对应原 src/refresh.ts）。

各平台凭据独立处理：未登录跳过，单个平台失败不影响另一个。
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime
from typing import Any

from app.sdk.auth import kg as kg_auth
from app.sdk.auth import tx as tx_auth

INTERVAL_SECONDS = 24 * 60 * 60
# 启动后延迟触发，避开启动期与冒烟测试的快速起停
STARTUP_DELAY_SECONDS = 10

_running = False
_tasks: list[asyncio.Task[None]] = []


def _log(msg: str) -> None:
    print(f"[{datetime.now().isoformat(timespec='milliseconds')}] [登录续期] {msg}")


async def refresh_all() -> dict[str, Any]:
    """手动/定时共用的续期入口，返回各平台结果（skipped / refreshed / error）。"""
    global _running
    if _running:
        return {"skipped": True}
    _running = True
    try:
        result: dict[str, Any] = {}
        for name, fn in (("kg", kg_auth.refresh_login), ("tx", tx_auth.refresh_login)):
            try:
                res = await fn()
                result[name] = res
                if isinstance(res, dict) and res.get("skipped"):
                    _log(f"{name}: 未登录，跳过")
                else:
                    _log(f"{name}: 登录态已刷新")
            except NotImplementedError:
                result[name] = {"skipped": True, "msg": "尚未移植"}
            except Exception as err:  # noqa: BLE001 - 单平台失败不影响其它平台
                result[name] = {"error": str(err)}
                _log(f"{name}: {err}")
        return result
    finally:
        _running = False


async def _loop() -> None:
    await asyncio.sleep(STARTUP_DELAY_SECONDS)
    while True:
        await refresh_all()
        await asyncio.sleep(INTERVAL_SECONDS)


def start_refresh_scheduler() -> None:
    """注册定时任务（在应用 startup 时调用）。"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # 无事件循环（如导入期）时忽略
        return
    task = loop.create_task(_loop())
    _tasks.append(task)
    _log(f"已启动自动续期（启动后 {STARTUP_DELAY_SECONDS}s 首刷，此后每 {INTERVAL_SECONDS // 3600}h 一次）")


async def stop_refresh_scheduler() -> None:
    while _tasks:
        task = _tasks.pop()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
