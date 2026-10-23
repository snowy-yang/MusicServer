"""HTTP 层回归测试：CORS、限流顺序、路由遮蔽、流式管道与登录存储。

测试通过 tests/conftest.py 的临时 DATA_DIR 隔离，不会写真实 data/auth.json。
HTTP 请求用 aiohttp 打到同一个进程内的 uvicorn，避免依赖 Starlette TestClient/httpx。
"""

from __future__ import annotations

import asyncio
import importlib
import socket
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote

import aiohttp
import app.routes.music as music
import app.sdk.apis.kw as kw
import app.sdk.auth.wy as wy
import app.sdk.auth_store as auth_store
import pytest
import uvicorn
from app.main import create_app
from app.sdk import SOURCE_MODULES


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class _LiveServer:
    """在后台线程运行真实 uvicorn，测试用 aiohttp 访问。"""

    def __init__(self, app: Any) -> None:
        self.port = _free_port()
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=self.port,
            log_level="error",
            access_log=False,
            lifespan="on",
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self) -> None:
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started:
            if not self.thread.is_alive() or time.time() > deadline:
                raise RuntimeError("测试服务器启动失败")
            time.sleep(0.01)

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=5)


@asynccontextmanager
async def live_client(app: Any) -> AsyncIterator[tuple[aiohttp.ClientSession, str]]:
    server = _LiveServer(app)
    await asyncio.to_thread(server.start)
    try:
        async with aiohttp.ClientSession() as session:
            yield session, f"http://127.0.0.1:{server.port}"
    finally:
        await asyncio.to_thread(server.stop)


async def test_cors_headers_and_preflight() -> None:
    async with live_client(create_app()) as (session, base):
        async with session.get(f"{base}/health", headers={"Origin": "http://example.com"}) as response:
            assert response.status == 200
            assert response.headers["access-control-allow-origin"] == "*"

        async with session.options(
            f"{base}/health",
            headers={"Origin": "http://example.com", "Access-Control-Request-Method": "GET"},
        ) as response:
            assert response.status == 200
            assert response.headers["access-control-allow-origin"] == "*"


async def test_rate_limit_counts_unauthorized_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTH_KEY", "secret")
    monkeypatch.setenv("RATE_LIMIT", "2")
    statuses: list[int] = []
    async with live_client(create_app()) as (session, base):
        for _ in range(3):
            async with session.get(f"{base}/health", headers={"X-Server-Key": "wrong"}) as response:
                statuses.append(response.status)
    # 前两次进入鉴权返回 401，第三次在鉴权之前被限流拦截。
    assert statuses == [401, 401, 429]


async def test_album_search_is_not_shadowed(monkeypatch: pytest.MonkeyPatch) -> None:
    kg = SOURCE_MODULES["kg"]

    async def fake_search(keyword: str, page: int = 1, limit: int = 20) -> dict:
        return {"list": [{"name": keyword}], "page": page, "limit": limit, "total": 1}

    monkeypatch.setattr(kg.album, "search_album", fake_search)
    async with live_client(create_app()) as (session, base):
        async with session.get(f"{base}/album/kg/search/{quote('魔杰座')}") as response:
            assert response.status == 200
            payload = await response.json()
    assert payload["data"]["list"][0]["name"] == "魔杰座"


async def test_parse_kind_is_not_a_query_parameter(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, str] = {}

    async def fake_parse(kind: str, source: str, link: str) -> dict:
        seen.update(kind=kind, source=source, link=link)
        return {"kind": kind}

    async with live_client(create_app()) as (session, base):
        async with session.get(f"{base}/openapi.json") as response:
            spec = await response.json()
        params = spec["paths"]["/parse/song/{source}"]["post"].get("parameters", [])
        assert "_kind" not in {item["name"] for item in params}

        monkeypatch.setattr(music, "_parse_handler", fake_parse)
        async with session.post(f"{base}/parse/song/kw?_kind=playlist", json={"link": "x"}) as response:
            assert response.status == 200

    assert seen == {"kind": "song", "source": "kw", "link": "x"}


async def test_5sing_quality_from_sources_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    fivesing = SOURCE_MODULES["5sing"]

    async def fake_url(song_info: dict, quality: str, retry_num: int = 0) -> dict:
        return {"type": "sq", "url": "https://example.com/a.mp3"}

    monkeypatch.setattr(fivesing, "get_music_url", fake_url)
    async with live_client(create_app()) as (session, base):
        async with session.get(f"{base}/url/5sing/932557%7Cyc", params={"quality": "sq"}) as response:
            assert response.status == 200
            payload = await response.json()
    assert payload["data"] == {"type": "sq", "url": "https://example.com/a.mp3"}


async def test_find_rejects_unknown_source() -> None:
    async with live_client(create_app()) as (session, base):
        async with session.get(f"{base}/find/nope/{quote('稻香')}") as response:
            assert response.status == 404


async def test_stream_sign_rejects_infinite_exp(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTH_KEY", "secret")
    async with live_client(create_app()) as (session, base):
        async with session.get(f"{base}/stream/mg/x", params={"exp": "inf", "sig": "x"}) as response:
            assert response.status == 401


async def test_stream_slow_consumer_does_not_hang(monkeypatch: pytest.MonkeyPatch) -> None:
    class DummyDecoder:
        @staticmethod
        def feed(chunk: bytes) -> bytes:
            return chunk

    async def fake_stream(url: str, feed, on_chunk) -> None:
        for _ in range(100):
            await on_chunk(b"x" * 1024)

    async def consume(response, delay: float) -> int:
        count = 0
        async for _ in response.body_iterator:
            count += 1
            await asyncio.sleep(delay)
        return count

    monkeypatch.setattr(music, "stream_decrypted", fake_stream)
    response = music._stream_response("http://example.com/a.mp3", DummyDecoder())  # type: ignore[arg-type]
    assert await asyncio.wait_for(consume(response, 0.001), timeout=5) == 100


async def test_stream_error_is_propagated(monkeypatch: pytest.MonkeyPatch) -> None:
    class DummyDecoder:
        @staticmethod
        def feed(chunk: bytes) -> bytes:
            return chunk

    async def failing_stream(url: str, feed, on_chunk) -> None:
        await on_chunk(b"x")
        raise RuntimeError("upstream boom")

    async def consume(response) -> None:
        async for _ in response.body_iterator:
            pass

    monkeypatch.setattr(music, "stream_decrypted", failing_stream)
    response = music._stream_response("http://example.com/a.mp3", DummyDecoder())  # type: ignore[arg-type]
    with pytest.raises(RuntimeError, match="upstream boom"):
        await asyncio.wait_for(consume(response), timeout=5)


async def test_kw_token_retry_does_not_deadlock(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom() -> list[str]:
        raise RuntimeError("network down")

    monkeypatch.setattr(kw, "fetch_home_set_cookie", boom)
    monkeypatch.setitem(kw._state, "token", None)
    monkeypatch.setitem(kw._state, "lock", None)
    with pytest.raises(RuntimeError, match="获取酷我token失败"):
        await asyncio.wait_for(kw.get_token(), timeout=2)


def test_auth_store_rejects_non_dict_json(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    importlib.reload(auth_store)
    (tmp_path / "auth.json").write_text("[]", encoding="utf-8")

    assert auth_store.get_credentials("wy") is None
    assert any(path.name.startswith("auth.json.corrupt-") for path in tmp_path.iterdir())


async def test_cookie_login_bind_and_logout() -> None:
    async with live_client(create_app()) as (session, base):
        async with session.post(f"{base}/login/bd", json={"cookie": "BDUSS=test"}) as response:
            assert response.status == 200

        async with session.get(f"{base}/login/status") as response:
            payload = await response.json()
        assert payload["data"]["bd"]["logged"] is True

        async with session.delete(f"{base}/login/bd") as response:
            assert response.status == 200

        async with session.get(f"{base}/login/status") as response:
            payload = await response.json()
        assert payload["data"]["bd"]["logged"] is False

        async with session.post(f"{base}/login/nope", json={"cookie": "x"}) as response:
            assert response.status == 404


async def test_wy_login_profile_uses_new_cookie(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, str | None] = {}

    async def fake_fetch(cookie: str | None = None) -> dict:
        seen["cookie"] = cookie
        return {"userid": 1, "nickname": "n", "avatar": None, "vipType": None}

    monkeypatch.setattr(wy, "_fetch_profile", fake_fetch)
    monkeypatch.setattr(wy, "set_credentials", lambda *args, **kwargs: None)

    profile = await wy._apply_login(["MUSIC_U=abc; Path=/"])
    assert seen["cookie"] is not None and seen["cookie"].startswith("MUSIC_U=abc")
    assert profile["nickname"] == "n"
