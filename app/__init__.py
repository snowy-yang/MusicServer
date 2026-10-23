"""MusicServer —— 多平台音乐聚合 API（Python 版）。

包布局：
  app/config.py          环境变量与路径
  app/sdk/               平台 SDK（HTTP 请求、工具、凭据、14 个平台适配器）
  app/http/              服务端横切能力（错误、鉴权、限流、流签名、咪咕解密代理）
  app/routes/            业务路由
  app/openapi/           OpenAPI 领域模型
  app/main.py            FastAPI 应用入口
"""

__version__ = "1.0.0"
