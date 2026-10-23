"""FastAPI 应用装配 —— 中间件、异常处理、OpenAPI 文档、路由注册。

与 Node 版语义对齐：
  * 成功响应统一包成 { code: 0, data }（由路由处理函数调用 `ok()` 显式构造，
    文档页、OpenAPI 规范与 /stream 媒体流为 raw 响应）
  * 业务错误 { code: <HTTP 状态码>, msg, detail? }
  * 422 参数校验失败、404 路由或平台不存在、405 方法不允许（带 Allow 头）、502 上游失败
  * 全部响应 Cache-Control: no-store
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import __version__, config
from app.http.api_error import ApiError
from app.http.auth_gate import auth_gate
from app.http.rate_limit import make_rate_limiter
from app.openapi.components import COMPONENT_SCHEMAS
from app.openapi.ui import redoc_html

API_TITLE = "MusicServer 聚合音乐 API"
API_DESCRIPTION = (
    "多平台音乐聚合接口：搜索、播放地址、歌词、封面、榜单、歌单、专辑、歌手、链接解析。"
    "支持 kw（酷我）/ kg（酷狗）/ tx（QQ音乐）/ wy（网易云）/ mg（咪咕）/ bd（千千）/ "
    "joox / bili（哔哩哔哩）/ 5sing / apple（Apple Music，仅试听）与有声平台 "
    "xm（喜马拉雅）/ me（猫耳FM）/ qt（蜻蜓FM）/ lr（懒人听书）。"
)


class Envelope(JSONResponse):
    """统一成功响应：{ code: 0, data }。文档里由路由的 responses 引用领域模型。"""

    def render(self, content: Any) -> bytes:
        return json.dumps({"code": 0, "data": content}, ensure_ascii=False).encode("utf-8")


def ok(data: Any, status_code: int = 200) -> Envelope:
    return Envelope(data, status_code=status_code)


def make_router(tag: str) -> APIRouter:
    return APIRouter(tags=[tag])


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """启动期副作用 —— 登录态自动续期（启动后延时首刷 + 每 24h 一次，与 TS 版一致）。"""
    from app.routes.refresh import start_refresh_scheduler, stop_refresh_scheduler

    start_refresh_scheduler()
    try:
        yield
    finally:
        await stop_refresh_scheduler()


def create_app() -> FastAPI:
    config.load_env()

    app = FastAPI(
        title=API_TITLE,
        description=API_DESCRIPTION,
        version=__version__,
        lifespan=_lifespan,
        openapi_url="/openapi.json",
        docs_url="/docs",
        redoc_url=None,
        openapi_tags=[
            {"name": "搜索", "description": "歌曲搜索与跨平台匹配"},
            {"name": "歌曲资源", "description": "播放地址、歌词、封面"},
            {"name": "榜单", "description": "排行榜"},
            {"name": "歌单", "description": "歌单与热搜"},
            {"name": "歌手专辑", "description": "歌手信息、歌曲与专辑详情"},
            {"name": "登录", "description": "账号登录与状态"},
            {"name": "系统", "description": "健康检查、平台信息、文档"},
        ],
    )
    app.state.started_at = time.time()
    app.state.auth_key = config.auth_key()

    # ---- 中间行为：限流 → 鉴权（限流先计数，401 爆破同样受限） ----
    app.middleware("http")(make_rate_limiter(config.rate_limit()))
    app.middleware("http")(auth_gate)

    @app.middleware("http")
    async def _no_store(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    # ---- 异常处理 ----
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        payload: dict[str, Any] = {"code": exc.status, "msg": str(exc)}
        if exc.detail is not None:
            payload["detail"] = exc.detail
        return JSONResponse(payload, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        errors = json.loads(json.dumps(exc.errors(), default=str))
        msg = "参数校验失败"
        if errors:
            first = errors[0]
            loc = ".".join(str(part) for part in first.get("loc", []) if part not in ("body", "query", "path"))
            msg = f"{loc}: {first.get('msg', msg)}" if loc else str(first.get("msg", msg))
        return JSONResponse({"code": 422, "msg": msg, "detail": errors}, status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException):
        if exc.status_code == 404:
            allowed = _allowed_methods(request)
            if allowed:
                return JSONResponse(
                    {"code": 405, "msg": f"方法 {request.method} 不允许，请使用 {', '.join(allowed)}"},
                    status_code=405,
                    headers={"Allow": ", ".join(allowed)},
                )
            return JSONResponse({"code": 404, "msg": f"接口不存在: {request.url.path}"}, status_code=404)
        detail = exc.detail if isinstance(exc.detail, str) else "请求失败"
        return JSONResponse({"code": exc.status_code, "msg": detail}, status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        print(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] {request.method} {request.url.path} 内部错误: {exc!r}")
        return JSONResponse({"code": 500, "msg": "服务器内部错误"}, status_code=500)

    # ---- 文档与入口 ----
    @app.get("/redoc", include_in_schema=False)
    async def redoc():
        return HTMLResponse(redoc_html(API_TITLE))

    @app.get("/", include_in_schema=False)
    async def root():
        return RedirectResponse("/docs", status_code=302)

    # ---- 业务路由 ----
    from app.routes.login import router as login_router
    from app.routes.music import router as music_router
    from app.routes.system import router as system_router

    app.include_router(music_router)
    app.include_router(login_router)
    app.include_router(system_router)

    _install_openapi(app)
    return app


def _allowed_methods(request: Request) -> list[str]:
    """路径存在但方法不允许 → 405 的 Allow 列表（OPTIONS/HEAD 不计入）。"""
    path = request.url.path
    methods: list[str] = []
    for route in request.app.routes:
        pattern = getattr(route, "path", "")
        if not pattern or not _match_path(pattern, path):
            continue
        for method in getattr(route, "methods", None) or []:
            if method not in {"OPTIONS", "HEAD"} and method not in methods:
                methods.append(method)
    return methods


def _match_path(pattern: str, path: str) -> bool:
    """把 `/url/{source}/{id}` 这类路径模板转成正则做匹配。"""
    regex = re.sub(r"\{[^}]+\}", "\u0000", pattern)
    regex = re.escape(regex).replace("\u0000", "[^/]+")
    return re.fullmatch(regex, path) is not None


def _install_openapi(app: FastAPI) -> None:
    """把领域模型挂进 components，并保留 FastAPI 自动生成的路径参数文档。"""
    from fastapi.openapi.utils import get_openapi

    def custom_openapi():
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(title=API_TITLE, version=__version__, description=API_DESCRIPTION, routes=app.routes)
        components = schema.setdefault("components", {}).setdefault("schemas", {})
        for name, definition in COMPONENT_SCHEMAS.items():
            components.setdefault(name, definition)
        app.openapi_schema = schema
        return schema

    app.openapi = custom_openapi  # type: ignore[method-assign]


app = create_app()
