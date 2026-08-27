"""Windows desktop shell for the portable KataGo Hand Talk application.

The launcher deliberately contains no imports from the web server (and, in
particular, no imports from the screenshot recognition stack).  A PyInstaller
``onedir`` build therefore only contains this small shell and pywebview.  The
heavy Python/Torch runtime remains in the project-local ``.venv`` and is
started as a child process when it is needed.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import json
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from ctypes import wintypes
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PureWindowsPath
from typing import Any, Callable, Mapping, Sequence


APP_NAME = "KataGoHandTalk"
APP_TITLE = "KataGo 手谈"
SERVICE_APP_ID = "katago-web-beginner"
SERVICE_API_VERSION = 1
RUNTIME_HEALTH_SCHEMA = 1
PREFERENCES_SCHEMA = 1
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5000
DEFAULT_STARTUP_TIMEOUT = 240.0
MUTEX_NAME = r"Local\KataGoHandTalk.Desktop.v1"
APPCOMPAT_LAYERS_KEY = (
    r"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers"
)
SNIPPING_TOOL_URI = (
    "ms-screenclip://capture/image?rectangle&enabledModes="
    "SnippingAllModes&user-agent=KataGoHandTalk"
)

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)

LOGGER = logging.getLogger("katago_handtalk.desktop")


class LauncherError(RuntimeError):
    """A startup problem that is safe to show on the launch page."""


class StartupCancelled(LauncherError):
    """Raised internally when the window is closed during startup."""


def _is_project_root(path: Path) -> bool:
    return (
        (path / "run-local.py").is_file()
        and (path / "setup-local.ps1").is_file()
        and (path / "server").is_dir()
        and (path / "static").is_dir()
    )


def _candidate_bases() -> list[Path]:
    """Return source and PyInstaller locations, in preference order."""
    result: list[Path] = []

    def add(value: object) -> None:
        if not value:
            return
        try:
            candidate = Path(str(value)).expanduser().resolve()
        except (OSError, RuntimeError, ValueError):
            return
        if candidate not in result:
            result.append(candidate)

    # In a PyInstaller onedir app, the executable is normally one directory
    # above _MEIPASS.  Test both because data files can be placed in either.
    add(Path(sys.executable).parent)
    add(getattr(sys, "_MEIPASS", None))
    add(Path(__file__).parent)
    add(Path.cwd())
    return result


def resolve_project_root(explicit: str | os.PathLike[str] | None = None) -> Path:
    """Locate the web project in a source checkout or PyInstaller onedir app.

    ``--project-root`` is authoritative, followed by
    ``KATAGO_HANDTALK_ROOT``.  The fallback walks upward from the executable,
    PyInstaller's data directory, this module and the current directory.  A
    few conventional child folders are also checked so both flat and nested
    onedir layouts work.
    """
    configured = explicit or os.environ.get("KATAGO_HANDTALK_ROOT")
    if configured:
        root = Path(configured).expanduser().resolve()
        if not _is_project_root(root):
            raise LauncherError(
                f"项目目录无效：{root}\n"
                "需要包含 run-local.py、setup-local.ps1、server 和 static。"
            )
        return root

    checked: set[Path] = set()
    child_names = ("KataGo-Web-Beginner", "app", "project", "resources")
    for base in _candidate_bases():
        for ancestor in (base, *list(base.parents)[:5]):
            candidates = [ancestor]
            candidates.extend(ancestor / name for name in child_names)
            # PyInstaller's default onedir content folder.
            candidates.extend((ancestor / "_internal", ancestor / "_internal" / "KataGo-Web-Beginner"))
            for candidate in candidates:
                try:
                    candidate = candidate.resolve()
                except (OSError, RuntimeError):
                    continue
                if candidate in checked:
                    continue
                checked.add(candidate)
                if _is_project_root(candidate):
                    return candidate

    raise LauncherError(
        "找不到 KataGo 项目目录。请重新安装，或使用 "
        "--project-root 指定包含 run-local.py 的目录。"
    )


def local_app_data_root() -> Path:
    """Return the writable per-user application directory."""
    configured = os.environ.get("LOCALAPPDATA")
    if configured:
        return Path(configured).expanduser().resolve() / APP_NAME
    # This fallback is useful for developer machines and non-Windows tests.
    return Path.home().resolve() / ".local" / "share" / APP_NAME


def create_session_log(log_dir: Path | None = None) -> Path:
    directory = (log_dir or (local_app_data_root() / "logs")).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    return directory / f"desktop-{stamp}-{os.getpid()}.log"


def configure_logging(log_file: Path) -> None:
    """Write launcher and pywebview diagnostics to the same session log."""
    log_file.parent.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    for logger in (LOGGER, logging.getLogger("pywebview")):
        logger.setLevel(logging.INFO)
        logger.propagate = False
        for handler in list(logger.handlers):
            handler.close()
            logger.removeHandler(handler)
        handler = logging.FileHandler(log_file, encoding="utf-8")
        handler.setFormatter(formatter)
        logger.addHandler(handler)


def _read_appcompat_layers() -> list[tuple[str, object]]:
    """Read current-user compatibility overrides without mutating Windows."""
    if os.name != "nt":
        return []
    try:
        import winreg

        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, APPCOMPAT_LAYERS_KEY)
    except (ImportError, OSError):
        return []

    values: list[tuple[str, object]] = []
    try:
        index = 0
        while True:
            try:
                name, value, _kind = winreg.EnumValue(key, index)
            except OSError:
                break
            values.append((name, value))
            index += 1
    finally:
        winreg.CloseKey(key)
    return values


def find_webview2_dpi_overrides(
    layer_values: Sequence[tuple[str, object]] | None = None,
    *,
    path_exists: Callable[[str], bool] | None = None,
) -> list[tuple[str, str]]:
    """Find live WebView2 AppCompat DPI flags known to break controllers."""
    values = _read_appcompat_layers() if layer_values is None else layer_values
    exists = path_exists or (lambda value: Path(value).is_file())
    conflicts: list[tuple[str, str]] = []
    for executable, raw_flags in values:
        if PureWindowsPath(str(executable)).name.casefold() != "msedgewebview2.exe":
            continue
        if not isinstance(raw_flags, str) or "HIGHDPIAWARE" not in raw_flags.upper():
            continue
        if not exists(str(executable)):
            continue
        conflicts.append((str(executable), raw_flags))
    return conflicts


def ensure_webview2_compatibility() -> None:
    """Fail visibly instead of opening a black window for a known DPI conflict."""
    conflicts = find_webview2_dpi_overrides()
    if not conflicts:
        return
    executable, flags = conflicts[0]
    raise LauncherError(
        "检测到 Windows 为 WebView2 强制启用了高 DPI 兼容模式，"
        "这会导致桌面窗口黑屏。\n\n"
        f"文件：{executable}\n"
        f"兼容设置：{flags}\n\n"
        "请在该文件的“属性 > 兼容性 > 更改高 DPI 设置”中取消覆盖，"
        "然后重新打开手谈 KataGo。"
    )


def load_always_on_top(preferences_file: Path) -> bool:
    """Read the persisted window preference, defaulting safely to ``False``."""
    try:
        payload = json.loads(preferences_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return False
    if not isinstance(payload, Mapping):
        return False
    return (
        payload.get("schema") == PREFERENCES_SCHEMA
        and payload.get("always_on_top") is True
    )


def save_always_on_top(preferences_file: Path, enabled: bool) -> None:
    """Atomically persist the only desktop preference currently supported."""
    preferences_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = preferences_file.with_name(
        f".{preferences_file.name}.{os.getpid()}.tmp"
    )
    try:
        temporary.write_text(
            json.dumps(
                {
                    "schema": PREFERENCES_SCHEMA,
                    "always_on_top": enabled,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, preferences_file)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def apply_window_topmost(window: Any, enabled: bool) -> None:
    """Change a live window's Z-order without blocking pywebview's JS bridge.

    pywebview 6.1 assigns WinForms ``TopMost`` directly.  When that setter is
    reached from a synchronous JavaScript API callback, WebView2 can deadlock
    waiting for the callback to finish.  ``SetWindowPos`` changes the same
    native window state without re-entering the managed WebView callback.
    """
    if os.name == "nt":
        native = getattr(window, "native", None)
        managed_handle = getattr(native, "Handle", None)
        if managed_handle is not None:
            try:
                handle_value = int(managed_handle.ToInt64())
            except (AttributeError, TypeError, ValueError):
                handle_value = int(managed_handle)
            if handle_value:
                user32 = ctypes.WinDLL("user32", use_last_error=True)
                set_window_pos = user32.SetWindowPos
                set_window_pos.argtypes = (
                    wintypes.HWND,
                    wintypes.HWND,
                    ctypes.c_int,
                    ctypes.c_int,
                    ctypes.c_int,
                    ctypes.c_int,
                    wintypes.UINT,
                )
                set_window_pos.restype = wintypes.BOOL
                insert_after = wintypes.HWND(-1 if enabled else -2)
                flags = 0x0001 | 0x0002 | 0x0010  # NOSIZE | NOMOVE | NOACTIVATE
                if not set_window_pos(
                    wintypes.HWND(handle_value), insert_after, 0, 0, 0, 0, flags
                ):
                    raise ctypes.WinError(ctypes.get_last_error())
                return

    # Development tests and non-Windows backends can use pywebview's normal
    # property because they do not have the WebView2 callback deadlock above.
    window.on_top = enabled


def is_reusable_status(payload: object) -> bool:
    """Return whether an ``/api/status`` payload belongs to this application."""
    if not isinstance(payload, Mapping):
        return False
    if payload.get("app") == SERVICE_APP_ID:
        version = payload.get("api_version")
        return version in (SERVICE_API_VERSION, str(SERVICE_API_VERSION))
    # Compatibility with builds made before the explicit marker was added.
    return all(key in payload for key in ("running", "katago_path", "model_path"))


def probe_service(
    port: int,
    *,
    host: str = DEFAULT_HOST,
    timeout: float = 0.6,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any] | None:
    """Fetch and validate the local service status without throwing."""
    request = urllib.request.Request(
        f"http://{host}:{port}/api/status",
        headers={"Accept": "application/json", "User-Agent": f"{APP_NAME}/1"},
    )
    try:
        with opener(request, timeout=timeout) as response:
            raw = response.read(256 * 1024)
        payload = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeError, urllib.error.URLError):
        return None
    return dict(payload) if is_reusable_status(payload) else None


def is_port_available(port: int, *, host: str = DEFAULT_HOST) -> bool:
    """Check whether a loopback TCP port can currently be bound."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
            sock.bind((host, port))
        return True
    except OSError:
        return False


def find_free_port(*, host: str = DEFAULT_HOST) -> int:
    """Ask Windows for a currently unused ephemeral loopback port."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


@dataclass(frozen=True)
class ServiceSelection:
    port: int
    reused: bool
    status: dict[str, Any] | None = None

    @property
    def url(self) -> str:
        return f"http://{DEFAULT_HOST}:{self.port}"


def select_service(
    preferred_port: int = DEFAULT_PORT,
    *,
    probe: Callable[[int], dict[str, Any] | None] = probe_service,
    port_available: Callable[[int], bool] = is_port_available,
    free_port: Callable[[], int] = find_free_port,
) -> ServiceSelection:
    """Reuse our service on the preferred port, otherwise choose a safe port.

    A newly started desktop service deliberately uses an ephemeral port even
    when the browser edition's conventional port is free.  This prevents an
    old browser tab (especially a still-active live-review tab) from silently
    reconnecting to the desktop process and consuming GPU resources.
    """
    status = probe(preferred_port)
    if status is not None and bool(status.get("running")):
        return ServiceSelection(preferred_port, True, status)
    # Keep this probe for callers/tests that supply a stricter availability
    # check, but never expose a new desktop instance on the browser port.
    port_available(preferred_port)
    return ServiceSelection(free_port(), False)


def _resource_bases(project_root: Path) -> list[Path]:
    bases = [project_root.parent, project_root]
    for base in _candidate_bases():
        bases.extend((base, base / "_internal"))
    unique: list[Path] = []
    for base in bases:
        try:
            base = base.resolve()
        except (OSError, RuntimeError):
            continue
        if base not in unique:
            unique.append(base)
    return unique


def _find_resource_dir(project_root: Path, name: str, required: Sequence[str]) -> Path:
    for base in _resource_bases(project_root):
        candidate = base / name
        if all((candidate / item).is_file() for item in required):
            return candidate.resolve()
    # Return the source-layout path so the eventual validation message is
    # deterministic and useful even when the resource is missing.
    return (project_root.parent / name).resolve()


@dataclass(frozen=True)
class RuntimePaths:
    project_root: Path
    python: Path
    katago: Path
    model: Path
    config: Path
    board_model: Path
    stone_model: Path


def find_venv_python(project_root: Path) -> Path | None:
    scripts = project_root / ".venv" / "Scripts"
    for name in ("pythonw.exe", "python.exe"):
        candidate = scripts / name
        if candidate.is_file():
            return candidate.resolve()
    return None


def resolve_runtime_paths(project_root: Path, *, require_python: bool = True) -> RuntimePaths:
    """Resolve the same engine/model/config layout as ``start-local.ps1``."""
    project_root = project_root.resolve()
    python = find_venv_python(project_root)
    if python is None:
        # Keep a stable expected path for diagnostics and pre-setup callers.
        python = project_root / ".venv" / "Scripts" / "python.exe"

    katago_root = _find_resource_dir(
        project_root,
        "KataGo",
        ("katago.exe", "models/kata1-tf2-b10c384-s2941M-d5872M.bin.gz"),
    )
    katrain_root = _find_resource_dir(project_root, "KaTrain", ("analysis_5060.cfg",))
    paths = RuntimePaths(
        project_root=project_root,
        python=python,
        katago=katago_root / "katago.exe",
        model=katago_root / "models" / "kata1-tf2-b10c384-s2941M-d5872M.bin.gz",
        config=katrain_root / "analysis_5060.cfg",
        board_model=project_root / "models" / "image2sgf" / "board.pth",
        stone_model=project_root / "models" / "image2sgf" / "stone.pth",
    )

    required = [paths.katago, paths.model, paths.config, paths.board_model, paths.stone_model]
    if require_python:
        required.insert(0, paths.python)
    missing = [path for path in required if not path.is_file()]
    if missing:
        details = "\n".join(f"  - {path}" for path in missing)
        raise LauncherError(f"缺少运行文件：\n{details}")
    return paths


def build_server_environment(
    paths: RuntimePaths,
    port: int,
    *,
    base: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Build the environment set by ``start-local.ps1 -NoBrowser``."""
    env = dict(os.environ if base is None else base)
    env.update(
        {
            "KATAGO_PATH": str(paths.katago),
            "KATAGO_MODEL": str(paths.model),
            "KATAGO_CONFIG": str(paths.config),
            "PORT": str(port),
            "DEFAULT_LANGUAGE": "zh",
            "DEFAULT_MAX_VISITS": "1000",
            "PYTHONUTF8": "1",
            "PYTHONUNBUFFERED": "1",
            "KATAGO_WEB_NO_BROWSER": "1",
        }
    )
    return env


class SingleInstanceMutex:
    """A process-lifetime named mutex on Windows.

    Non-Windows platforms simply succeed; the shipped application is Windows
    only, while the no-op keeps the core unit-testable elsewhere.
    """

    ERROR_ALREADY_EXISTS = 183

    def __init__(self, name: str = MUTEX_NAME) -> None:
        self.name = name
        self._handle: int | None = None

    def acquire(self) -> bool:
        if os.name != "nt":
            self._handle = -1
            return True
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        create_mutex = kernel32.CreateMutexW
        create_mutex.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
        create_mutex.restype = wintypes.HANDLE
        ctypes.set_last_error(0)
        handle = create_mutex(None, False, self.name)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if ctypes.get_last_error() == self.ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle(handle)
            return False
        self._handle = int(handle)
        return True

    def release(self) -> None:
        if self._handle is None:
            return
        if os.name == "nt" and self._handle != -1:
            ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle(self._handle)
        self._handle = None

    def __enter__(self) -> "SingleInstanceMutex":
        if not self.acquire():
            raise LauncherError("KataGo 手谈已经打开。")
        return self

    def __exit__(self, *_: object) -> None:
        self.release()


class WindowsProcessJob:
    """Kill-on-close Job Object containing exactly one owned process tree."""

    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9

    def __init__(self) -> None:
        self.handle: int | None = None
        self.assigned = False

    def assign(self, process: subprocess.Popen[str]) -> bool:
        if os.name != "nt":
            return False
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_uint64),
                ("WriteOperationCount", ctypes.c_uint64),
                ("OtherOperationCount", ctypes.c_uint64),
                ("ReadTransferCount", ctypes.c_uint64),
                ("WriteTransferCount", ctypes.c_uint64),
                ("OtherTransferCount", ctypes.c_uint64),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        create_job = kernel32.CreateJobObjectW
        create_job.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        create_job.restype = wintypes.HANDLE
        set_info = kernel32.SetInformationJobObject
        set_info.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
        set_info.restype = wintypes.BOOL
        assign_job = kernel32.AssignProcessToJobObject
        assign_job.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        assign_job.restype = wintypes.BOOL

        handle = create_job(None, None)
        if not handle:
            LOGGER.warning("CreateJobObjectW failed: %s", ctypes.get_last_error())
            return False
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = self.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not set_info(
            handle,
            self.JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            LOGGER.warning("SetInformationJobObject failed: %s", ctypes.get_last_error())
            kernel32.CloseHandle(handle)
            return False
        process_handle = wintypes.HANDLE(getattr(process, "_handle"))
        if not assign_job(handle, process_handle):
            LOGGER.warning("AssignProcessToJobObject failed: %s", ctypes.get_last_error())
            kernel32.CloseHandle(handle)
            return False
        self.handle = int(handle)
        self.assigned = True
        return True

    def close(self) -> None:
        if self.handle is not None and os.name == "nt":
            ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle(self.handle)
        self.handle = None
        self.assigned = False


def terminate_process_tree(
    process: subprocess.Popen[str],
    job: WindowsProcessJob | None = None,
    *,
    timeout: float = 8.0,
) -> None:
    """Terminate only the child tree rooted at ``process.pid``."""
    if process.poll() is not None:
        if job is not None:
            job.close()
        return

    if job is not None and job.assigned:
        # Closing a KILL_ON_JOB_CLOSE object atomically terminates all current
        # descendants, including KataGo started by run-local.py.
        job.close()
        try:
            process.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            pass

    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW,
                timeout=timeout,
            )
        except (OSError, subprocess.TimeoutExpired):
            LOGGER.exception("Could not terminate process tree %s", process.pid)
    else:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            process.wait(timeout=min(timeout, 3.0))
        except (OSError, subprocess.TimeoutExpired):
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except OSError:
                pass

    if job is not None:
        job.close()


@dataclass
class OwnedProcess:
    process: subprocess.Popen[str]
    job: WindowsProcessJob


STARTUP_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KataGo 手谈</title>
<style>
:root{color-scheme:dark;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;
background:radial-gradient(circle at 25% 12%,#2f5a4d 0,#172821 34%,#0d1512 75%);color:#f4f1e9}
.card{width:min(620px,calc(100vw - 40px));padding:38px;border:1px solid #ffffff1c;
border-radius:22px;background:#101b17e8;box-shadow:0 24px 80px #0008;backdrop-filter:blur(12px)}
.brand{display:flex;align-items:center;gap:15px}.stone{width:46px;height:46px;border-radius:50%;
background:radial-gradient(circle at 32% 27%,#fff,#d8d8d8 45%,#777);box-shadow:0 8px 18px #0009}
h1{font-size:25px;margin:0;font-weight:650;letter-spacing:.02em}.sub{margin:4px 0 0;color:#aebbb5;font-size:13px}
.progress{height:5px;margin:30px 0 20px;border-radius:9px;background:#ffffff13;overflow:hidden}
.bar{height:100%;width:34%;border-radius:9px;background:#d8b36a;animation:move 1.35s ease-in-out infinite}
@keyframes move{0%{transform:translateX(-110%)}100%{transform:translateX(310%)}}
#title{font-size:16px;font-weight:600;margin-bottom:8px}#detail{min-height:48px;color:#aebbb5;
line-height:1.6;font-size:13px;white-space:pre-wrap;word-break:break-word}.actions{display:none;gap:10px;margin-top:22px}
button{border:0;border-radius:10px;padding:10px 16px;color:#172019;background:#d8b36a;font-weight:650;cursor:pointer}
button.secondary{color:#dce5e0;background:#ffffff12}.error .bar{width:100%;animation:none;background:#db6d67}
.error #title{color:#ffaaa4}.error .actions{display:flex}.ready .bar{width:100%;animation:none;background:#69bc8d}
</style></head><body><main class="card" id="card"><div class="brand"><div class="stone"></div><div>
<h1>KataGo 手谈</h1><p class="sub">本地运行 · 自动连接 KataGo</p></div></div>
<div class="progress"><div class="bar"></div></div><div id="title">正在准备…</div>
<div id="detail">检查本地服务和运行环境</div><div class="actions">
<button onclick="retry()">重试</button><button class="secondary" onclick="openLogs()">打开日志</button></div></main>
<script>
window.launcherSetState=function(s){const c=document.getElementById('card');c.classList.remove('error','ready');
if(s.kind)c.classList.add(s.kind);document.getElementById('title').textContent=s.title||'正在准备…';
document.getElementById('detail').textContent=s.detail||'';};
async function retry(){try{await window.pywebview.api.retry_startup()}catch(e){}}
async function openLogs(){try{await window.pywebview.api.open_logs()}catch(e){}}
</script></body></html>"""


class DesktopApi:
    """Small native bridge available to both launch and application pages."""

    def __init__(self, log_dir: Path, launcher: "DesktopLauncher | None" = None) -> None:
        # Keep implementation objects private even though the desktop bridge is
        # registered with an explicit function whitelist below.  Passing this
        # object to pywebview's ``js_api`` reflection would otherwise recurse
        # into Path/launcher/window objects and expose far more than intended.
        self._log_dir = log_dir.resolve()
        self._launcher = launcher

    def attach(self, launcher: "DesktopLauncher") -> None:
        self._launcher = launcher

    def retry_startup(self) -> bool:
        return bool(self._launcher and self._launcher.retry())

    def open_logs(self) -> bool:
        try:
            self._log_dir.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                os.startfile(str(self._log_dir))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(self._log_dir)])
            else:
                subprocess.Popen(["xdg-open", str(self._log_dir)])
            return True
        except OSError:
            LOGGER.exception("Could not open log directory")
            return False

    def open_snipping_tool(self) -> bool:
        """Open the Windows 11 screen clipping overlay."""
        if os.name != "nt":
            return False
        try:
            os.startfile(SNIPPING_TOOL_URI)  # type: ignore[attr-defined]
            return True
        except OSError:
            try:
                subprocess.Popen(
                    ["explorer.exe", SNIPPING_TOOL_URI],
                    creationflags=CREATE_NO_WINDOW,
                )
                return True
            except OSError:
                LOGGER.exception("Could not open Snipping Tool")
                return False

    def client_ready(self, payload: object = None) -> bool:
        """Record that the embedded page completed its Socket.IO handshake."""
        LOGGER.info("Desktop client ready: %s", payload)
        return True

    def client_error(self, payload: object = None) -> bool:
        """Persist embedded JavaScript failures in the normal desktop log."""
        LOGGER.error("Desktop client error: %s", payload)
        return True

    def get_always_on_top(self) -> bool:
        """Return whether the native window is currently pinned above others."""
        return bool(self._launcher and self._launcher.always_on_top)

    def set_always_on_top(self, enabled: object) -> bool:
        """Set and persist the native window's topmost state."""
        if not self._launcher:
            return False
        return self._launcher.set_always_on_top(enabled)

    def read_clipboard_image(self) -> str | None:
        """Return a native PNG clipboard payload as a data URL when available.

        The Snipping Tool publishes the registered ``PNG`` clipboard format on
        current Windows releases.  If an application only publishes CF_DIB,
        return ``None`` so the web UI can fall back to its normal Ctrl+V path.
        No Pillow/Torch dependency is pulled into the desktop executable.
        """
        if os.name != "nt":
            return None
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        register_format = user32.RegisterClipboardFormatW
        register_format.argtypes = (wintypes.LPCWSTR,)
        register_format.restype = wintypes.UINT
        png_format = register_format("PNG")
        if not png_format:
            return None

        open_clipboard = user32.OpenClipboard
        open_clipboard.argtypes = (wintypes.HWND,)
        open_clipboard.restype = wintypes.BOOL
        get_data = user32.GetClipboardData
        get_data.argtypes = (wintypes.UINT,)
        get_data.restype = wintypes.HANDLE
        global_lock = kernel32.GlobalLock
        global_lock.argtypes = (wintypes.HGLOBAL,)
        global_lock.restype = ctypes.c_void_p
        global_size = kernel32.GlobalSize
        global_size.argtypes = (wintypes.HGLOBAL,)
        global_size.restype = ctypes.c_size_t
        global_unlock = kernel32.GlobalUnlock
        global_unlock.argtypes = (wintypes.HGLOBAL,)
        global_unlock.restype = wintypes.BOOL
        close_clipboard = user32.CloseClipboard
        close_clipboard.argtypes = ()
        close_clipboard.restype = wintypes.BOOL

        for _ in range(4):
            if open_clipboard(None):
                break
            time.sleep(0.04)
        else:
            return None
        try:
            handle = get_data(png_format)
            if not handle:
                return None
            size = global_size(handle)
            pointer = global_lock(handle)
            if not pointer or not size:
                return None
            try:
                raw = ctypes.string_at(pointer, size)
            finally:
                global_unlock(handle)
        finally:
            close_clipboard()
        if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            return None
        return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


class DesktopLauncher:
    """Own the startup workflow and only the processes it creates."""

    def __init__(
        self,
        project_root: Path,
        log_file: Path,
        *,
        startup_timeout: float = DEFAULT_STARTUP_TIMEOUT,
        preferred_port: int = DEFAULT_PORT,
        popen: Callable[..., subprocess.Popen[str]] = subprocess.Popen,
    ) -> None:
        self.project_root = project_root.resolve()
        self.log_file = log_file.resolve()
        self.log_dir = self.log_file.parent
        self.startup_timeout = startup_timeout
        self.preferred_port = preferred_port
        self._popen = popen
        self.window: Any | None = None
        self.api = DesktopApi(self.log_dir, self)
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._worker: threading.Thread | None = None
        self._owned: OwnedProcess | None = None
        self._ready = False
        self._preferences_file = self.log_dir.parent / "preferences.json"
        self._always_on_top = load_always_on_top(self._preferences_file)
        self._last_state: dict[str, str] = {
            "kind": "working",
            "title": "正在准备…",
            "detail": "检查本地服务和运行环境",
        }
        # If setup fails after creating python.exe, retry must still rerun it.
        self._needs_setup = find_venv_python(self.project_root) is None

    @property
    def owned_process(self) -> subprocess.Popen[str] | None:
        with self._lock:
            return self._owned.process if self._owned else None

    @property
    def always_on_top(self) -> bool:
        with self._lock:
            return self._always_on_top

    def attach_window(self, window: Any) -> None:
        self.window = window

    def set_always_on_top(self, enabled: object) -> bool:
        """Apply a validated topmost state and remember it for the next launch."""
        if type(enabled) is not bool:
            LOGGER.warning("Ignoring invalid always-on-top value: %r", enabled)
            return self.always_on_top

        window = self.window
        if window is None:
            return self.always_on_top
        try:
            apply_window_topmost(window, enabled)
        except Exception:
            LOGGER.exception("Could not change always-on-top state")
            return self.always_on_top

        with self._lock:
            self._always_on_top = enabled
        try:
            save_always_on_top(self._preferences_file, enabled)
        except OSError:
            LOGGER.exception("Could not persist always-on-top preference")
        LOGGER.info("Always-on-top changed: %s", enabled)
        return enabled

    def expose_native_api(self) -> None:
        """Register the small native bridge allowlist before WebView startup.

        Functions registered with ``Window.expose`` remain in pywebview's
        function table and are injected again after every navigation.  This is
        intentionally used instead of ``js_api=self.api``: reflective js_api
        discovery walks public object attributes recursively and can expose
        unrelated launcher and filesystem methods.
        """
        window = self.window
        if window is None:
            raise LauncherError("桌面窗口尚未创建")
        try:
            window.expose(
                self.api.retry_startup,
                self.api.open_logs,
                self.api.open_snipping_tool,
                self.api.read_clipboard_image,
                self.api.client_ready,
                self.api.client_error,
                self.api.get_always_on_top,
                self.api.set_always_on_top,
            )
            LOGGER.info("Native desktop API whitelist registered")
        except Exception as exc:
            raise LauncherError(f"无法注册桌面功能：{exc}") from exc

    def start(self) -> None:
        self.retry()

    def retry(self) -> bool:
        with self._lock:
            if self._stop_event.is_set() or self._ready:
                return False
            if self._worker is not None and self._worker.is_alive():
                return False
            self._worker = threading.Thread(
                target=self._startup_worker,
                daemon=True,
                name="desktop-startup",
            )
            self._worker.start()
            return True

    def stop(self, *_: object) -> None:
        if self._stop_event.is_set():
            return
        LOGGER.info("Desktop window closed; stopping owned process tree")
        self._stop_event.set()
        self._cleanup_owned()

    def _set_state(self, kind: str, title: str, detail: str = "") -> None:
        state = {"kind": kind, "title": title, "detail": detail}
        self._last_state = state
        window = self.window
        if window is None:
            return
        script = "window.launcherSetState(" + json.dumps(state, ensure_ascii=False) + ")"
        try:
            window.evaluate_js(script)
        except Exception:
            # The first update can race WebView2 loading the inline document.
            LOGGER.debug("Launch page is not ready for a state update", exc_info=True)

    def _startup_worker(self) -> None:
        try:
            self._set_state("working", "正在检查本地服务…", "连接 127.0.0.1")
            selection = select_service(self.preferred_port)
            if selection.reused:
                LOGGER.info("Reusing service at %s", selection.url)
                self._show_application(selection.url, reused=True)
                return

            self._ensure_runtime()
            self._check_cancelled()

            # Setup can take a while.  Re-check so a service started meanwhile
            # is reused and so we do not assume the earlier port is still free.
            selection = select_service(self.preferred_port)
            if selection.reused:
                LOGGER.info("Reusing service that appeared during setup at %s", selection.url)
                self._show_application(selection.url, reused=True)
                return

            paths = resolve_runtime_paths(self.project_root)
            env = build_server_environment(paths, selection.port)
            self._set_state(
                "working",
                "正在启动 KataGo…",
                f"本地服务端口 {selection.port}，首次载入模型可能需要一点时间",
            )
            process = self._start_server(paths, env)
            status = self._wait_until_ready(selection.port, process)
            LOGGER.info("Service ready on port %s: %s", selection.port, status)
            self._show_application(selection.url, reused=False)
        except StartupCancelled:
            LOGGER.info("Startup cancelled")
        except Exception as exc:
            LOGGER.exception("Desktop startup failed")
            self._cleanup_owned()
            if not self._stop_event.is_set():
                message = str(exc).strip() or exc.__class__.__name__
                self._set_state(
                    "error",
                    "启动失败",
                    f"{message}\n\n可点击“重试”，详细信息已写入：\n{self.log_file}",
                )
        finally:
            with self._lock:
                if self._worker is threading.current_thread():
                    self._worker = None

    def _check_cancelled(self) -> None:
        if self._stop_event.is_set():
            raise StartupCancelled("窗口已关闭")

    def _ensure_runtime(self) -> None:
        python = find_venv_python(self.project_root)
        if not self._needs_setup and python is not None:
            if self._runtime_is_healthy(python):
                return
            LOGGER.warning("Existing local runtime failed its import smoke test; repairing it")
            self._needs_setup = True
        setup_script = self.project_root / "setup-local.ps1"
        if not setup_script.is_file():
            raise LauncherError(f"找不到首次运行脚本：{setup_script}")
        self._set_state(
            "working",
            "首次运行，正在安装本地环境…",
            "这一步只需执行一次；下载和安装可能需要几分钟。",
        )
        LOGGER.info("Running first-time setup: %s", setup_script)
        command = [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(setup_script),
        ]
        owned = self._spawn_owned(command, cwd=self.project_root, env=dict(os.environ))
        process = owned.process
        assert process.stdout is not None
        try:
            for raw_line in iter(process.stdout.readline, ""):
                self._check_cancelled()
                line = raw_line.strip()
                if not line:
                    continue
                LOGGER.info("[setup] %s", line)
                self._set_state("working", "首次运行，正在安装本地环境…", line[-500:])
            return_code = process.wait()
        finally:
            self._release_completed(owned)
        if return_code != 0:
            raise LauncherError(f"本地环境安装失败（退出代码 {return_code}）")
        python = find_venv_python(self.project_root)
        if python is None:
            raise LauncherError("安装脚本已结束，但未找到 .venv\\Scripts\\python.exe")
        if not self._runtime_is_healthy(python):
            raise LauncherError("本地环境安装已结束，但依赖自检仍未通过；请打开日志查看详情")
        self._needs_setup = False
        LOGGER.info("First-time setup completed")

    def _runtime_is_healthy(self, python: Path) -> bool:
        """Verify the existing venv before trusting a partial prior setup.

        A failed first installation can leave ``python.exe`` behind even when
        Flask, OpenCV, or the CUDA PyTorch wheels are missing.  A small import
        smoke test lets the normal setup script repair that state automatically
        instead of sending the user into a retry loop.
        """
        fingerprint = self._runtime_fingerprint(python)
        stamp_file = self.project_root / ".runtime" / "desktop-runtime-health.json"
        if fingerprint is not None:
            try:
                cached = json.loads(stamp_file.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError):
                cached = None
            if cached == fingerprint:
                LOGGER.info("Local runtime health cache is current")
                return True

        self._set_state(
            "working",
            "正在检查本地环境…",
            "确认网页、截图识别和显卡运行库完整",
        )
        console_python = python.with_name("python.exe")
        if not console_python.is_file():
            console_python = python
        code = (
            "import cv2, flask, flask_socketio, simple_websocket, torch, torchvision; "
            "assert torch.version.cuda is not None, 'CUDA PyTorch runtime is missing'"
        )
        owned: OwnedProcess | None = None
        try:
            owned = self._spawn_owned(
                [str(console_python), "-c", code],
                cwd=self.project_root,
                env={**os.environ, "PYTHONUTF8": "1"},
            )
            output, _ = owned.process.communicate(timeout=45)
            self._check_cancelled()
            if owned.process.returncode == 0:
                LOGGER.info("Local runtime import smoke test passed")
                if fingerprint is not None:
                    try:
                        stamp_file.parent.mkdir(parents=True, exist_ok=True)
                        temporary = stamp_file.with_suffix(".tmp")
                        temporary.write_text(
                            json.dumps(fingerprint, ensure_ascii=False, sort_keys=True),
                            encoding="utf-8",
                        )
                        os.replace(temporary, stamp_file)
                    except OSError:
                        # A cache failure only makes the next launch repeat the
                        # safe smoke test; it must never block the application.
                        LOGGER.warning("Could not update local runtime health cache", exc_info=True)
                return True
            LOGGER.warning(
                "Local runtime import smoke test failed (exit %s): %s",
                owned.process.returncode,
                (output or "").strip()[-2000:],
            )
            return False
        except subprocess.TimeoutExpired:
            LOGGER.warning("Local runtime import smoke test timed out")
            if owned is not None:
                terminate_process_tree(owned.process, owned.job)
            return False
        except (OSError, ValueError):
            LOGGER.exception("Could not run local runtime import smoke test")
            return False
        finally:
            if owned is not None:
                self._release_completed(owned)

    def _runtime_fingerprint(self, python: Path) -> dict[str, Any] | None:
        """Return a cheap dependency fingerprint for subsequent fast starts."""
        site_packages = python.parent.parent / "Lib" / "site-packages"
        anchors = [
            python.with_name("python.exe"),
            self.project_root / "requirements.txt",
            self.project_root / "setup-local.ps1",
            site_packages / "flask" / "__init__.py",
            site_packages / "flask_socketio" / "__init__.py",
            site_packages / "simple_websocket" / "__init__.py",
            site_packages / "cv2" / "__init__.py",
            site_packages / "torch" / "__init__.py",
            site_packages / "torchvision" / "__init__.py",
            site_packages / "torch" / "lib" / "torch_cuda.dll",
        ]
        files: dict[str, dict[str, int]] = {}
        try:
            for path in anchors:
                stat = path.stat()
                if not path.is_file():
                    return None
                files[str(path.relative_to(self.project_root)).replace("\\", "/")] = {
                    "size": stat.st_size,
                    "mtime_ns": stat.st_mtime_ns,
                }
        except (OSError, ValueError):
            return None
        return {"schema": RUNTIME_HEALTH_SCHEMA, "files": files}

    def _start_server(self, paths: RuntimePaths, env: Mapping[str, str]) -> subprocess.Popen[str]:
        command = [str(paths.python), str(self.project_root / "run-local.py")]
        owned = self._spawn_owned(command, cwd=self.project_root, env=dict(env))
        thread = threading.Thread(
            target=self._pump_server_log,
            args=(owned.process,),
            daemon=True,
            name="desktop-server-log",
        )
        thread.start()
        return owned.process

    def _spawn_owned(
        self,
        command: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
    ) -> OwnedProcess:
        kwargs: dict[str, Any] = {
            "cwd": str(cwd),
            "env": dict(env),
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "bufsize": 1,
        }
        if os.name == "nt":
            kwargs["creationflags"] = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        LOGGER.info("Starting child: %s", subprocess.list2cmdline(list(command)))
        process = self._popen(list(command), **kwargs)
        job = WindowsProcessJob()
        job.assign(process)
        owned = OwnedProcess(process, job)
        with self._lock:
            if self._stop_event.is_set():
                terminate_process_tree(process, job)
                raise StartupCancelled("窗口已关闭")
            self._owned = owned
        return owned

    def _release_completed(self, owned: OwnedProcess) -> None:
        with self._lock:
            if self._owned is owned:
                self._owned = None
        owned.job.close()

    def _pump_server_log(self, process: subprocess.Popen[str]) -> None:
        if process.stdout is None:
            return
        try:
            for raw_line in iter(process.stdout.readline, ""):
                line = raw_line.rstrip()
                if line:
                    LOGGER.info("[server] %s", line)
        except (OSError, ValueError):
            LOGGER.debug("Server output pipe closed")

    def _wait_until_ready(
        self,
        port: int,
        process: subprocess.Popen[str],
    ) -> dict[str, Any]:
        deadline = time.monotonic() + self.startup_timeout
        while time.monotonic() < deadline:
            self._check_cancelled()
            return_code = process.poll()
            if return_code is not None:
                raise LauncherError(f"本地服务提前退出（退出代码 {return_code}）")
            status = probe_service(port, timeout=0.8)
            if status is not None and bool(status.get("running", True)):
                return status
            self._stop_event.wait(0.35)
        raise LauncherError(f"等待 KataGo 就绪超时（{self.startup_timeout:g} 秒）")

    def _show_application(self, url: str, *, reused: bool) -> None:
        self._check_cancelled()
        self._set_state(
            "ready",
            "连接成功",
            "正在打开棋盘" + ("（已复用现有服务）" if reused else ""),
        )
        window = self.window
        if window is None:
            raise LauncherError("桌面窗口尚未创建")
        with self._lock:
            # Mark the navigation before load_url so the loaded event knows it
            # is the application page rather than the inline startup page.
            self._ready = True
        try:
            window.load_url(url)
        except Exception as exc:
            with self._lock:
                self._ready = False
            raise LauncherError(f"无法打开本地界面：{exc}") from exc

    def _cleanup_owned(self) -> None:
        with self._lock:
            owned = self._owned
            self._owned = None
        if owned is not None:
            LOGGER.info("Terminating owned process tree rooted at PID %s", owned.process.pid)
            terminate_process_tree(owned.process, owned.job)


def _show_native_error(message: str, title: str = APP_TITLE) -> None:
    if os.name == "nt":
        try:
            ctypes.windll.user32.MessageBoxW(None, message, title, 0x10)
            return
        except Exception:
            pass
    print(f"{title}: {message}", file=sys.stderr)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="KataGo 手谈桌面启动器")
    parser.add_argument(
        "--project-root",
        help="包含 run-local.py 的项目目录（安装快捷方式会自动传入）",
    )
    parser.add_argument(
        "--startup-timeout",
        type=float,
        default=DEFAULT_STARTUP_TIMEOUT,
        help=argparse.SUPPRESS,
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    log_file = create_session_log()
    configure_logging(log_file)
    LOGGER.info("Desktop launcher starting; executable=%s", sys.executable)

    mutex = SingleInstanceMutex()
    try:
        if not mutex.acquire():
            _show_native_error("KataGo 手谈已经打开。", APP_TITLE)
            return 0
        project_root = resolve_project_root(args.project_root)
        LOGGER.info("Project root: %s", project_root)
        ensure_webview2_compatibility()
        try:
            import webview  # type: ignore[import-not-found]
        except ImportError as exc:
            raise LauncherError("桌面组件 pywebview 未安装，请重新安装桌面版。") from exc

        launcher = DesktopLauncher(
            project_root,
            log_file,
            startup_timeout=max(1.0, args.startup_timeout),
        )
        window = webview.create_window(
            APP_TITLE,
            html=STARTUP_HTML,
            width=1180,
            height=820,
            min_size=(900, 650),
            maximized=True,
            on_top=launcher.always_on_top,
            background_color="#0d1512",
        )
        launcher.attach_window(window)
        launcher.expose_native_api()
        window.events.closed += launcher.stop
        try:
            # ``edgechromium`` explicitly selects the installed WebView2
            # runtime rather than the legacy MSHTML backend.
            webview.start(launcher.start, gui="edgechromium", debug=False)
        finally:
            launcher.stop()
        return 0
    except LauncherError as exc:
        LOGGER.exception("Launcher error")
        _show_native_error(f"{exc}\n\n日志：{log_file}")
        return 1
    except Exception as exc:
        LOGGER.exception("Unexpected desktop launcher error")
        _show_native_error(f"启动失败：{exc}\n\n日志：{log_file}")
        return 1
    finally:
        mutex.release()


if __name__ == "__main__":
    raise SystemExit(main())
