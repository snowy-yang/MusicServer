"""启动器（scripts/serve.py）的循环/服务器选择逻辑测试（不启动真实服务器）。"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import serve


def test_pick_server_auto_prefers_granian(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve, "has_module", lambda name: name == "granian")
    assert serve.pick_server("auto") == "granian"

    monkeypatch.setattr(serve, "has_module", lambda name: False)
    assert serve.pick_server("auto") == "uvicorn"


def test_available_loops_follow_installed_packages(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve, "has_module", lambda name: name == "winloop")
    assert serve.available_loops("granian") == ["auto", "asyncio", "winloop"]
    assert serve.available_loops("uvicorn") == ["auto", "asyncio"]

    monkeypatch.setattr(serve, "has_module", lambda name: name in ("rloop", "uvloop"))
    assert serve.available_loops("granian") == ["auto", "asyncio", "rloop", "uvloop"]
    assert serve.available_loops("uvicorn") == ["auto", "asyncio", "uvloop"]


def test_explicit_unavailable_loop_fails_with_hint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve, "has_module", lambda name: False)
    with pytest.raises(SystemExit) as error:
        serve.resolve_loop("granian", "rloop")
    message = str(error.value)
    assert "rloop" in message and "可用" in message


def test_uvicorn_rejects_granian_only_loops() -> None:
    with pytest.raises(SystemExit):
        serve.resolve_loop("uvicorn", "winloop")
    with pytest.raises(SystemExit):
        serve.resolve_loop("uvicorn", "rloop")


def test_uvicorn_auto_and_asyncio_allowed() -> None:
    assert serve.resolve_loop("uvicorn", "auto") == "auto"
    assert serve.resolve_loop("uvicorn", "asyncio") == "asyncio"


def test_build_command_granian(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve, "has_module", lambda name: True)
    command = serve.build_command("granian", host="0.0.0.0", port=16688, workers=2, loop="winloop", reload=True)
    assert command[:3] == [sys.executable, "-m", "granian"]
    assert command[command.index("--loop") + 1] == "winloop"
    assert command[command.index("--workers") + 1] == "2"
    assert "--reload" in command
    assert command[-1] == serve.APP_TARGET


def test_build_command_uvicorn() -> None:
    command = serve.build_command("uvicorn", host="127.0.0.1", port=9000, workers=1, loop="auto", reload=False)
    assert command[:3] == [sys.executable, "-m", "uvicorn"]
    assert command[3] == serve.APP_TARGET
    assert "--reload" not in command
