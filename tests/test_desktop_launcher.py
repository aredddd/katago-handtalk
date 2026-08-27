from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

import desktop_launcher as dl


def make_project(tmp_path: Path, *, with_python: bool = True) -> Path:
    root = tmp_path / "KataGo-Web-Beginner"
    (root / "server").mkdir(parents=True)
    (root / "static").mkdir()
    (root / "models" / "image2sgf").mkdir(parents=True)
    (root / "run-local.py").write_text("print('server')", encoding="utf-8")
    (root / "setup-local.ps1").write_text("Write-Host setup", encoding="utf-8")
    (root / "models" / "image2sgf" / "board.pth").write_bytes(b"board")
    (root / "models" / "image2sgf" / "stone.pth").write_bytes(b"stone")
    if with_python:
        scripts = root / ".venv" / "Scripts"
        scripts.mkdir(parents=True)
        (scripts / "python.exe").write_bytes(b"python")
        (scripts / "pythonw.exe").write_bytes(b"pythonw")

    katago = tmp_path / "KataGo"
    (katago / "models").mkdir(parents=True)
    (katago / "katago.exe").write_bytes(b"katago")
    (katago / "models" / "kata1-tf2-b10c384-s2941M-d5872M.bin.gz").write_bytes(b"model")
    katrain = tmp_path / "KaTrain"
    katrain.mkdir()
    (katrain / "analysis_5060.cfg").write_text("cfg", encoding="utf-8")
    return root


def test_resolve_project_root_accepts_cli_and_environment(tmp_path, monkeypatch):
    root = make_project(tmp_path)
    assert dl.resolve_project_root(root) == root.resolve()

    monkeypatch.setenv("KATAGO_HANDTALK_ROOT", str(root))
    assert dl.resolve_project_root() == root.resolve()


def test_resolve_project_root_rejects_incomplete_directory(tmp_path):
    with pytest.raises(dl.LauncherError, match="项目目录无效"):
        dl.resolve_project_root(tmp_path)


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"app": "katago-web-beginner", "api_version": 1}, True),
        ({"app": "katago-web-beginner", "api_version": "1"}, True),
        ({"running": True, "katago_path": "k", "model_path": "m"}, True),
        ({"app": "another-app", "api_version": 1}, False),
        ({"running": True, "katago_path": "k"}, False),
        ([], False),
    ],
)
def test_reusable_status_marker_and_legacy_shape(payload, expected):
    assert dl.is_reusable_status(payload) is expected


def test_probe_service_parses_only_our_status():
    class Response:
        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def read(self, _limit):
            return json.dumps(self.payload).encode()

    good = {"app": dl.SERVICE_APP_ID, "api_version": 1, "running": True}
    assert dl.probe_service(5000, opener=lambda *_args, **_kwargs: Response(good)) == good
    assert (
        dl.probe_service(
            5000,
            opener=lambda *_args, **_kwargs: Response({"app": "somebody-else"}),
        )
        is None
    )


def test_select_service_reuses_or_avoids_an_occupied_foreign_port():
    status = {"app": dl.SERVICE_APP_ID, "api_version": 1, "running": True}
    reused = dl.select_service(
        probe=lambda _port: status,
        port_available=lambda _port: False,
        free_port=lambda: 61234,
    )
    assert reused == dl.ServiceSelection(5000, True, status)

    alternate = dl.select_service(
        probe=lambda _port: None,
        port_available=lambda _port: False,
        free_port=lambda: 61234,
    )
    assert alternate.port == 61234
    assert alternate.reused is False

    isolated = dl.select_service(
        probe=lambda _port: None,
        port_available=lambda _port: True,
        free_port=lambda: 62345,
    )
    assert isolated == dl.ServiceSelection(62345, False)

    stopped = dl.select_service(
        probe=lambda _port: {
            "app": dl.SERVICE_APP_ID,
            "api_version": 1,
            "running": False,
        },
        port_available=lambda _port: False,
        free_port=lambda: 63456,
    )
    assert stopped == dl.ServiceSelection(63456, False)


def test_runtime_paths_and_environment_match_start_script(tmp_path):
    root = make_project(tmp_path)
    paths = dl.resolve_runtime_paths(root)
    assert paths.python.name == "pythonw.exe"
    assert paths.katago == (tmp_path / "KataGo" / "katago.exe").resolve()
    assert paths.config == (tmp_path / "KaTrain" / "analysis_5060.cfg").resolve()

    env = dl.build_server_environment(paths, 54321, base={"KEEP": "yes"})
    assert env == {
        "KEEP": "yes",
        "KATAGO_PATH": str(paths.katago),
        "KATAGO_MODEL": str(paths.model),
        "KATAGO_CONFIG": str(paths.config),
        "PORT": "54321",
        "DEFAULT_LANGUAGE": "zh",
        "DEFAULT_MAX_VISITS": "1000",
        "PYTHONUTF8": "1",
        "PYTHONUNBUFFERED": "1",
        "KATAGO_WEB_NO_BROWSER": "1",
    }


def test_runtime_validation_reports_all_missing_files(tmp_path):
    root = make_project(tmp_path)
    (tmp_path / "KataGo" / "katago.exe").unlink()
    (root / "models" / "image2sgf" / "stone.pth").unlink()
    with pytest.raises(dl.LauncherError) as error:
        dl.resolve_runtime_paths(root)
    message = str(error.value)
    assert "katago.exe" in message
    assert "stone.pth" in message


def test_first_run_streams_setup_and_uses_hidden_powershell(tmp_path, monkeypatch):
    root = make_project(tmp_path, with_python=False)
    log_file = tmp_path / "logs" / "session.log"

    answers = iter([None, None, root / ".venv" / "Scripts" / "python.exe"])
    monkeypatch.setattr(dl, "find_venv_python", lambda _root: next(answers))
    launcher = dl.DesktopLauncher(root, log_file)

    class Process:
        pid = 123
        stdout = io.StringIO("[1/5] downloading\n[2/5] installing\n")

        @staticmethod
        def wait():
            return 0

    class Job:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True

    captured = {}
    owned = dl.OwnedProcess(Process(), Job())

    def fake_spawn(command, **kwargs):
        captured["command"] = command
        captured.update(kwargs)
        launcher._owned = owned
        return owned

    monkeypatch.setattr(launcher, "_spawn_owned", fake_spawn)
    monkeypatch.setattr(launcher, "_runtime_is_healthy", lambda _python: True)
    launcher._ensure_runtime()
    assert captured["command"][0] == "powershell.exe"
    assert "-ExecutionPolicy" in captured["command"]
    assert captured["command"][-1].endswith("setup-local.ps1")
    assert launcher._needs_setup is False


def test_existing_broken_runtime_is_repaired_instead_of_trusted(tmp_path, monkeypatch):
    root = make_project(tmp_path)
    launcher = dl.DesktopLauncher(root, tmp_path / "logs" / "session.log")
    health = iter([False, True])
    monkeypatch.setattr(launcher, "_runtime_is_healthy", lambda _python: next(health))

    class Process:
        pid = 123
        stdout = io.StringIO("setup repaired runtime\n")

        @staticmethod
        def wait():
            return 0

    class Job:
        def close(self):
            pass

    owned = dl.OwnedProcess(Process(), Job())

    def fake_spawn(_command, **_kwargs):
        launcher._owned = owned
        return owned

    monkeypatch.setattr(launcher, "_spawn_owned", fake_spawn)
    launcher._ensure_runtime()
    assert launcher._needs_setup is False


def test_server_command_uses_venv_python_and_no_browser_environment(tmp_path, monkeypatch):
    root = make_project(tmp_path)
    launcher = dl.DesktopLauncher(root, tmp_path / "logs" / "session.log")
    paths = dl.resolve_runtime_paths(root)
    env = dl.build_server_environment(paths, 5000, base={})
    captured = {}

    class Process:
        pid = 11
        stdout = io.StringIO("")

    class Job:
        def close(self):
            pass

    def fake_spawn(command, **kwargs):
        captured["command"] = command
        captured.update(kwargs)
        return dl.OwnedProcess(Process(), Job())

    monkeypatch.setattr(launcher, "_spawn_owned", fake_spawn)
    launcher._start_server(paths, env)
    assert captured["command"] == [str(paths.python), str(root / "run-local.py")]
    assert captured["env"]["KATAGO_WEB_NO_BROWSER"] == "1"


def test_reused_service_is_loaded_but_never_owned(tmp_path, monkeypatch):
    root = make_project(tmp_path)
    launcher = dl.DesktopLauncher(root, tmp_path / "logs" / "session.log")

    class Window:
        def __init__(self):
            self.urls = []

        def evaluate_js(self, _script):
            pass

        def load_url(self, url):
            self.urls.append(url)

    window = Window()
    launcher.attach_window(window)
    status = {"app": dl.SERVICE_APP_ID, "api_version": 1, "running": True}
    monkeypatch.setattr(
        dl,
        "select_service",
        lambda _port: dl.ServiceSelection(5000, True, status),
    )
    launcher._startup_worker()
    assert window.urls == ["http://127.0.0.1:5000"]
    assert launcher.owned_process is None


def test_stop_terminates_only_the_recorded_owned_tree(tmp_path, monkeypatch):
    root = make_project(tmp_path)
    launcher = dl.DesktopLauncher(root, tmp_path / "logs" / "session.log")

    class Process:
        pid = 77

    process = Process()
    job = object()
    launcher._owned = dl.OwnedProcess(process, job)
    calls = []
    monkeypatch.setattr(dl, "terminate_process_tree", lambda proc, guard: calls.append((proc, guard)))
    launcher.stop()
    launcher.stop()
    assert calls == [(process, job)]
    assert launcher.owned_process is None


def test_desktop_api_exposes_snipping_and_clipboard_fallback(tmp_path, monkeypatch):
    api = dl.DesktopApi(tmp_path / "logs")
    assert callable(api.open_snipping_tool)
    assert callable(api.read_clipboard_image)
    assert api.client_ready({"socketId": "test"}) is True
    assert api.client_error({"message": "test"}) is True

    monkeypatch.setattr(dl.os, "name", "posix")
    assert api.open_snipping_tool() is False
    assert api.read_clipboard_image() is None


def test_cli_accepts_packaged_project_root(tmp_path):
    parsed = dl.build_arg_parser().parse_args(["--project-root", str(tmp_path)])
    assert parsed.project_root == str(tmp_path)


def test_native_bridge_registers_only_the_explicit_allowlist(tmp_path):
    root = make_project(tmp_path)
    launcher = dl.DesktopLauncher(root, tmp_path / "logs" / "session.log")

    class Window:
        def __init__(self):
            self.exposed = []

        def expose(self, *functions):
            self.exposed.extend(function.__name__ for function in functions)

    window = Window()
    launcher.attach_window(window)
    launcher.expose_native_api()
    assert window.exposed == [
        "retry_startup",
        "open_logs",
        "open_snipping_tool",
        "read_clipboard_image",
        "client_ready",
        "client_error",
    ]


def test_desktop_api_keeps_launcher_and_paths_private(tmp_path):
    api = dl.DesktopApi(tmp_path / "logs")
    assert not hasattr(api, "launcher")
    assert not hasattr(api, "log_dir")


def test_launcher_source_does_not_import_heavy_runtime():
    source = Path(dl.__file__).read_text(encoding="utf-8")
    assert "import torch" not in source
    assert "from torch" not in source
