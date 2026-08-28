from __future__ import annotations

import io
import json
import logging
from pathlib import Path

import pytest

import desktop_launcher as dl


def make_project(tmp_path: Path, *, with_python: bool = True) -> Path:
    root = tmp_path / "KataGo-Web-Beginner"
    (root / "server").mkdir(parents=True)
    (root / "static").mkdir()
    (root / "config").mkdir()
    (root / "models" / "image2sgf").mkdir(parents=True)
    (root / "run-local.py").write_text("print('server')", encoding="utf-8")
    (root / "setup-local.ps1").write_text("Write-Host setup", encoding="utf-8")
    for requirement in (
        "requirements.txt",
        "requirements.lock.txt",
        "requirements-vision.txt",
        "requirements-vision.lock.txt",
        "requirements-torch.txt",
        "requirements-torch-cpu.lock.txt",
        "requirements-torch-cuda.lock.txt",
    ):
        (root / requirement).write_text("# test\n", encoding="utf-8")
    (root / "config" / "default_analysis.cfg").write_text("maxVisits = 1000", encoding="utf-8")
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
    return root


def test_resolve_project_root_accepts_cli_and_environment(tmp_path, monkeypatch):
    root = make_project(tmp_path)
    assert dl.resolve_project_root(root) == root.resolve()

    monkeypatch.setenv("KATAGO_HANDTALK_ROOT", str(root))
    assert dl.resolve_project_root() == root.resolve()


def test_resolve_project_root_rejects_incomplete_directory(tmp_path):
    with pytest.raises(dl.LauncherError, match="项目目录无效"):
        dl.resolve_project_root(tmp_path)


def test_webview2_dpi_override_detection_only_blocks_live_runtime():
    values = [
        (r"C:\Apps\Other.exe", "HIGHDPIAWARE"),
        (r"C:\WebView\msedgewebview2.exe", "~ HIGHDPIAWARE"),
        (r"C:\Old\msedgewebview2.exe", "HIGHDPIAWARE"),
        (r"C:\WebView\msedgewebview2.exe", 123),
    ]

    assert dl.find_webview2_dpi_overrides(
        values,
        path_exists=lambda value: value.startswith(r"C:\WebView"),
    ) == [(r"C:\WebView\msedgewebview2.exe", "~ HIGHDPIAWARE")]


def test_webview2_dpi_override_has_visible_launcher_error(monkeypatch):
    monkeypatch.setattr(
        dl,
        "find_webview2_dpi_overrides",
        lambda: [(r"C:\WebView\msedgewebview2.exe", "HIGHDPIAWARE")],
    )

    with pytest.raises(dl.LauncherError, match="桌面窗口黑屏"):
        dl.ensure_webview2_compatibility()


def test_pywebview_errors_share_desktop_session_log(tmp_path):
    log_file = tmp_path / "desktop.log"
    dl.configure_logging(log_file)
    try:
        logging.getLogger("pywebview").error("WebView2 initialization failed: 0x8007139F")
        for handler in logging.getLogger("pywebview").handlers:
            handler.flush()

        contents = log_file.read_text(encoding="utf-8")
        assert "pywebview" in contents
        assert "0x8007139F" in contents
    finally:
        for logger in (dl.LOGGER, logging.getLogger("pywebview")):
            for handler in list(logger.handlers):
                handler.close()
                logger.removeHandler(handler)


@pytest.mark.parametrize(
    ("payload", "token", "expected"),
    [
        ({"app": "katago-web-beginner", "api_version": 1, "session_token": "secret"}, "secret", True),
        ({"app": "katago-web-beginner", "api_version": "1", "session_token": "secret"}, "secret", True),
        ({"app": "katago-web-beginner", "api_version": 1, "session_token": "wrong"}, "secret", False),
        ({"running": True, "katago_path": "k", "model_path": "m"}, "secret", False),
        ({"app": "another-app", "api_version": 1, "session_token": "secret"}, "secret", False),
        ([], "secret", False),
    ],
)
def test_status_requires_exact_per_launch_token(payload, token, expected):
    assert dl.is_reusable_status(payload, token) is expected


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

    good = {
        "app": dl.SERVICE_APP_ID,
        "api_version": 1,
        "session_token": "secret",
        "running": True,
    }
    assert dl.probe_service(
        5000,
        expected_token="secret",
        opener=lambda *_args, **_kwargs: Response(good),
    ) == good
    assert (
        dl.probe_service(
            5000,
            expected_token="secret",
            opener=lambda *_args, **_kwargs: Response({"app": "somebody-else"}),
        )
        is None
    )


def test_select_service_never_reuses_an_existing_local_page():
    checked = []
    isolated = dl.select_service(
        port_available=lambda port: checked.append(port) or False,
        free_port=lambda: 62345,
    )
    assert checked == [5000]
    assert isolated == dl.ServiceSelection(62345, False)


def test_runtime_paths_and_environment_match_start_script(tmp_path):
    root = make_project(tmp_path)
    paths = dl.resolve_runtime_paths(root)
    assert paths.python.name == "pythonw.exe"
    assert paths.katago == (tmp_path / "KataGo" / "katago.exe").resolve()
    assert paths.config == (root / "config" / "default_analysis.cfg").resolve()
    assert paths.vision_enabled is True

    env = dl.build_server_environment(paths, 54321, base={"KEEP": "yes"})
    assert env == {
        "KEEP": "yes",
        "KATAGO_PATH": str(paths.katago),
        "KATAGO_MODEL": str(paths.model),
        "KATAGO_CONFIG": str(paths.config),
        "KATAGO_WORK_DIR": str(dl.runtime_data_root() / "katago-work"),
        "KATAGO_HANDTALK_DATA_DIR": str(dl.local_app_data_root()),
        "PORT": "54321",
        "DEFAULT_LANGUAGE": "zh",
        "DEFAULT_MAX_VISITS": "1000",
        "PYTHONUTF8": "1",
        "PYTHONUNBUFFERED": "1",
        "KATAGO_WEB_NO_BROWSER": "1",
        "KATAGO_VISION_ENABLED": "1",
        "KATAGO_HANDTALK_DESKTOP": "1",
        "KATAGO_VISION_BOARD_MODEL": str(paths.board_model),
        "KATAGO_VISION_STONE_MODEL": str(paths.stone_model),
    }


def test_new_vision_model_directory_is_preferred_as_a_complete_pair(tmp_path):
    root = make_project(tmp_path)
    preferred = root / "models" / "vision"
    preferred.mkdir()
    (preferred / "board.pth").write_bytes(b"new-board")
    (preferred / "stone.pth").write_bytes(b"new-stone")

    settings = dl.discover_runtime_settings(root)

    assert settings.board_model == (preferred / "board.pth").resolve()
    assert settings.stone_model == (preferred / "stone.pth").resolve()


def test_incomplete_new_vision_directory_falls_back_to_legacy_pair(tmp_path):
    root = make_project(tmp_path)
    preferred = root / "models" / "vision"
    preferred.mkdir()
    (preferred / "board.pth").write_bytes(b"new-board")

    settings = dl.discover_runtime_settings(root)

    assert settings.board_model == (root / "models" / "image2sgf" / "board.pth").resolve()
    assert settings.stone_model == (root / "models" / "image2sgf" / "stone.pth").resolve()


def test_runtime_validation_reports_all_missing_files(tmp_path):
    root = make_project(tmp_path)
    (tmp_path / "KataGo" / "katago.exe").unlink()
    (root / "models" / "image2sgf" / "stone.pth").unlink()
    settings = dl.RuntimeSettings(
        katago=tmp_path / "KataGo" / "katago.exe",
        model=tmp_path / "KataGo" / "models" / "kata1-tf2-b10c384-s2941M-d5872M.bin.gz",
        config=root / "config" / "default_analysis.cfg",
        vision_enabled=True,
        board_model=root / "models" / "image2sgf" / "board.pth",
        stone_model=root / "models" / "image2sgf" / "stone.pth",
    )
    with pytest.raises(dl.LauncherError) as error:
        dl.resolve_runtime_paths(root, settings=settings)
    message = str(error.value)
    assert "katago.exe" in message
    assert "stone.pth" in message


def test_runtime_settings_are_atomic_and_vision_is_optional(tmp_path):
    root = make_project(tmp_path)
    settings_file = tmp_path / "desktop-data" / "settings.json"
    settings = dl.RuntimeSettings(
        katago=tmp_path / "KataGo" / "katago.exe",
        model=tmp_path / "KataGo" / "models" / "kata1-tf2-b10c384-s2941M-d5872M.bin.gz",
        config=root / "config" / "default_analysis.cfg",
        vision_enabled=False,
    )
    dl.save_runtime_settings(settings_file, settings)
    assert not settings_file.with_suffix(".json.tmp").exists()
    assert dl.load_runtime_settings(settings_file) == settings

    (root / "models" / "image2sgf" / "board.pth").unlink()
    (root / "models" / "image2sgf" / "stone.pth").unlink()
    paths = dl.resolve_runtime_paths(
        root,
        require_python=False,
        settings_file=settings_file,
    )
    assert paths.vision_enabled is False
    assert paths.katago.is_file()


def test_missing_engine_opens_trusted_first_run_configuration(tmp_path):
    root = make_project(tmp_path)
    (tmp_path / "KataGo" / "katago.exe").unlink()
    launcher = dl.DesktopLauncher(root, tmp_path / "desktop-data" / "logs" / "session.log")

    class Window:
        def __init__(self):
            self.scripts = []

        def evaluate_js(self, script):
            self.scripts.append(script)

    window = Window()
    launcher.attach_window(window)
    launcher._startup_worker()
    assert any('"kind": "configure"' in script for script in window.scripts)
    assert launcher.owned_process is None


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
    monkeypatch.setattr(launcher, "_runtime_is_healthy", lambda *_args: True)
    launcher._ensure_runtime(dl.discover_runtime_settings(root))
    assert captured["command"][0] == "powershell.exe"
    assert "-ExecutionPolicy" in captured["command"]
    assert str(root / "setup-local.ps1") in captured["command"]
    assert "-VisionBackend" in captured["command"]
    assert launcher._needs_setup is False


def test_existing_broken_runtime_is_repaired_instead_of_trusted(tmp_path, monkeypatch):
    root = make_project(tmp_path)
    launcher = dl.DesktopLauncher(root, tmp_path / "logs" / "session.log")
    health = iter([False, True])
    monkeypatch.setattr(launcher, "_runtime_is_healthy", lambda *_args: next(health))

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
    launcher._ensure_runtime(dl.discover_runtime_settings(root))
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


def test_startup_navigates_only_after_its_own_token_is_verified(tmp_path, monkeypatch):
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
    process = object()
    captured = {}
    monkeypatch.setattr(launcher, "_ensure_runtime", lambda _settings: None)
    monkeypatch.setattr(dl, "select_service", lambda _port: dl.ServiceSelection(61234, False))
    monkeypatch.setattr(launcher, "_start_server", lambda _paths, _env: process)
    def verified(port, child, token):
        captured.update(port=port, child=child, token=token)
        return {
            "app": dl.SERVICE_APP_ID,
            "api_version": 1,
            "session_token": token,
            "running": True,
        }
    monkeypatch.setattr(launcher, "_wait_until_ready", verified)
    launcher._startup_worker()
    assert window.urls == ["http://127.0.0.1:61234"]
    assert captured == {
        "port": 61234,
        "child": process,
        "token": launcher._session_token,
    }
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
    assert callable(api.get_always_on_top)
    assert callable(api.set_always_on_top)
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
        "choose_runtime_file",
        "save_runtime_config",
        "open_runtime_configuration",
        "open_logs",
        "open_snipping_tool",
        "read_clipboard_image",
        "client_ready",
        "client_error",
        "get_always_on_top",
        "set_always_on_top",
    ]


def test_always_on_top_controls_window_and_persists(tmp_path):
    root = make_project(tmp_path)
    log_file = tmp_path / "desktop-data" / "logs" / "session.log"
    launcher = dl.DesktopLauncher(root, log_file)

    class Window:
        on_top = False

    window = Window()
    launcher.attach_window(window)

    assert launcher.api.get_always_on_top() is False
    assert launcher.api.set_always_on_top(True) is True
    assert window.on_top is True
    preferences = tmp_path / "desktop-data" / "preferences.json"
    assert json.loads(preferences.read_text(encoding="utf-8")) == {
        "schema": 1,
        "always_on_top": True,
    }

    restarted = dl.DesktopLauncher(root, log_file)
    assert restarted.always_on_top is True
    restarted.attach_window(window)
    assert restarted.api.set_always_on_top("yes") is True
    assert window.on_top is True
    assert restarted.api.set_always_on_top(False) is False
    assert window.on_top is False


def test_live_windows_use_native_z_order_without_pywebview_setter(monkeypatch):
    calls = []

    class SetWindowPos:
        argtypes = None
        restype = None

        def __call__(self, *args):
            calls.append(args)
            return 1

    class User32:
        pass

    user32 = User32()
    user32.SetWindowPos = SetWindowPos()

    class Window:
        native = type("Native", (), {"Handle": 123})()

        @property
        def on_top(self):
            return False

        @on_top.setter
        def on_top(self, _enabled):
            raise AssertionError("pywebview's managed setter must not be used")

    monkeypatch.setattr(dl.os, "name", "nt")
    monkeypatch.setattr(dl.ctypes, "WinDLL", lambda *_args, **_kwargs: user32)

    dl.apply_window_topmost(Window(), True)

    assert len(calls) == 1
    assert calls[0][0].value == 123
    assert calls[0][-1] == 0x0001 | 0x0002 | 0x0010


def test_desktop_api_keeps_launcher_and_paths_private(tmp_path):
    api = dl.DesktopApi(tmp_path / "logs")
    assert not hasattr(api, "launcher")
    assert not hasattr(api, "log_dir")


def test_launcher_source_does_not_import_heavy_runtime():
    source = Path(dl.__file__).read_text(encoding="utf-8")
    assert "import torch" not in source
    assert "from torch" not in source


def test_startup_error_can_return_to_runtime_configuration():
    assert 'onclick="configure()">修改配置</button>' in dl.STARTUP_HTML
    assert "window.pywebview.api.open_runtime_configuration()" in dl.STARTUP_HTML


def test_runtime_fingerprint_distinguishes_vision_backends(tmp_path):
    root = make_project(tmp_path)
    python = root / ".venv" / "Scripts" / "python.exe"
    site_packages = root / ".venv" / "Lib" / "site-packages"
    for relative in (
        "flask/__init__.py",
        "flask_socketio/__init__.py",
        "simple_websocket/__init__.py",
        "cv2/__init__.py",
        "torch/__init__.py",
        "torchvision/__init__.py",
    ):
        path = site_packages / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# test\n", encoding="utf-8")
    (root / "requirements.txt").write_text("flask\n", encoding="utf-8")
    (root / "requirements.lock.txt").write_text("flask==3.1.3\n", encoding="utf-8")
    (root / "requirements-vision.txt").write_text("opencv-python\n", encoding="utf-8")
    (root / "requirements-vision.lock.txt").write_text("opencv-python==5\n", encoding="utf-8")

    launcher = dl.DesktopLauncher(root, tmp_path / "logs" / "session.log")
    cuda = launcher._runtime_fingerprint(python, True, "cuda")
    cpu = launcher._runtime_fingerprint(python, True, "cpu")

    assert cuda is not None and cpu is not None
    assert cuda["vision_backend"] == "cuda"
    assert cpu["vision_backend"] == "cpu"
    assert cuda != cpu
    assert cuda["schema"] == 2
    assert cuda["app_version"] == dl.APP_VERSION
    assert all(
        "sha256" in record and "mtime_ns" not in record
        for record in cuda["files"].values()
    )


def test_setup_replaces_and_verifies_the_selected_torch_wheel_flavor():
    source = Path("setup-local.ps1").read_text(encoding="utf-8")
    assert source.count("--require-hashes") >= 3
    assert "requirements-torch-cuda.lock.txt" in source
    assert "requirements-torch-cpu.lock.txt" in source
    assert "--reinstall-package torch" in source
    assert "--reinstall-package torchvision" in source
    assert "--torch-backend $TorchBackend" in source
    assert 'suffix = "+cu128" if backend == "CUDA" else "+cpu"' in source
    assert "torch.version.cuda is None" in source
    assert "$PythonVersion = \"3.11.16\"" in source
    assert "ActualUvVersion" in source
    assert "ActualPythonVersion" in source


def test_start_script_prefers_the_new_vision_weight_directory():
    source = Path("start-local.ps1").read_text(encoding="utf-8")
    preferred = source.index('models\\vision\\board.pth')
    legacy = source.index('models\\image2sgf\\board.pth')

    assert preferred < legacy
    assert "$PreferredBoardVisionModel" in source
    assert "$LegacyBoardVisionModel" in source
