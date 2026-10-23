"""登录态存储 —— 各平台凭据持久化（data/auth.json，不入库）。

结构：{ wy: {...}, kg: {...}, tx: {...}, _kg_device: {...} }

凭据是明文敏感数据：文件以 0600 创建；写入走「同目录临时文件 + 原子替换」，
避免写中途崩溃留下截断 JSON（那会导致下次启动解析失败而丢掉全部平台凭据）。
DATA_DIR 环境变量可覆盖存储目录（测试用，避免污染真实登录态）。
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import UTC
from pathlib import Path
from typing import Any

from app.config import data_dir

_lock = threading.Lock()
_cache: dict[str, Any] = {}
_loaded = False
_cache_path: str | None = None
_cache_mtime: int | None = None


def _data_file() -> Path:
    return data_dir() / "auth.json"


def _mtime(path: Path) -> int | None:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return None


def _backup_corrupt(path: Path, err: Exception) -> None:
    """损坏文件先备份再重置，避免后续 set_credentials 用空表覆盖可抢救的数据。"""
    backup = path.with_name(f"{path.name}.corrupt-{int(time.time() * 1000)}")
    try:
        path.rename(backup)
        print(f"[auth/store] {path} 解析失败，已备份为 {backup}，本次以空凭据启动: {err}")
    except OSError:
        print(f"[auth/store] {path} 解析失败且备份未成功，本次以空凭据启动: {err}")


def _load() -> dict[str, Any]:
    """读取凭据缓存；文件被外部修改（mtime 变化）时自动重载。"""
    global _cache, _loaded, _cache_path, _cache_mtime
    path = _data_file()
    mtime = _mtime(path)
    if _loaded and _cache_path == str(path) and _cache_mtime == mtime:
        return _cache

    try:
        if mtime is None:
            _cache = {}
        else:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("auth.json 顶层必须是 JSON 对象")
            _cache = data
    except (ValueError, OSError) as err:
        _backup_corrupt(path, err)
        _cache = {}
    _loaded = True
    _cache_path = str(path)
    _cache_mtime = _mtime(path)
    return _cache


def _save(data: dict[str, Any]) -> None:
    global _cache, _loaded, _cache_path, _cache_mtime
    path = _data_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(data, ensure_ascii=False, indent=2))
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    _cache = data
    _loaded = True
    _cache_path = str(path)
    _cache_mtime = _mtime(path)


def get_credentials(platform: str) -> dict[str, Any] | None:
    with _lock:
        return _load().get(platform)


def set_credentials(platform: str, credentials: dict[str, Any]) -> None:
    with _lock:
        data = dict(_load())
        merged = {**data.get(platform, {}), **credentials, "updatedAt": _iso_now()}
        data[platform] = merged
        _save(data)


def clear_credentials(platform: str) -> None:
    with _lock:
        data = dict(_load())
        data.pop(platform, None)
        _save(data)


def _iso_now() -> str:
    from datetime import datetime

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ---- 各平台便捷读法（未登录返回空值，与原文一致） ----


def get_wy_cookie() -> str:
    cred = get_credentials("wy") or {}
    return str(cred.get("cookie") or "")


def get_kg_auth() -> dict[str, Any] | None:
    cred = get_credentials("kg") or {}
    if not cred.get("token"):
        return None
    return {"token": cred["token"], "userid": cred.get("userid") or 0}


def get_tx_auth() -> dict[str, Any] | None:
    import re

    cred = get_credentials("tx") or {}
    cookie = str(cred.get("cookie") or "")
    if not cookie:
        return None
    match = re.search(r"uin=(\d+)", cookie)
    return {"cookie": cookie, "uin": match.group(1) if match else "0"}


def get_cookie(platform: str) -> str:
    """通用 cookie 读取（xm/me/lr/mg/bd/joox/apple/5sing 等）。"""
    cred = get_credentials(platform) or {}
    return str(cred.get("cookie") or "").strip()
