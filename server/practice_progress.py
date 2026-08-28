"""Small, crash-safe persistence layer for local tsumego progress."""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Mapping


logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
_PROBLEM_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_INTEGER_FIELDS = {
    "attempts",
    "successes",
    "streak",
    "lapses",
    "hints_used",
}
_STRING_FIELDS = {"last_result", "due_at", "updated_at"}
_LAST_RESULTS = {"success", "failure", "skipped", ""}
_REQUIRED_FIELDS = _INTEGER_FIELDS | _STRING_FIELDS | {"solved"}


class InvalidProgress(ValueError):
    """Raised when a browser sends an invalid progress record."""


class ProgressStoreUnavailable(RuntimeError):
    """Raised when existing progress cannot be read without risking loss."""


def validate_problem_id(problem_id: str) -> str:
    if not isinstance(problem_id, str) or not _PROBLEM_ID.fullmatch(problem_id):
        raise InvalidProgress("Invalid problem id")
    return problem_id


def validate_record(value: Any, *, require_complete: bool = True) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise InvalidProgress("Progress record must be an object")

    allowed = _INTEGER_FIELDS | _STRING_FIELDS | {"solved"}
    unknown = set(value) - allowed
    if unknown:
        raise InvalidProgress(f"Unknown progress field: {sorted(unknown)[0]}")
    if require_complete:
        missing = _REQUIRED_FIELDS - set(value)
        if missing:
            raise InvalidProgress(f"Missing progress field: {sorted(missing)[0]}")

    record: dict[str, Any] = {}
    for field in _INTEGER_FIELDS:
        if field not in value:
            continue
        item = value[field]
        if isinstance(item, bool) or not isinstance(item, int) or item < 0:
            raise InvalidProgress(f"{field} must be a non-negative integer")
        record[field] = item

    if "solved" in value:
        if not isinstance(value["solved"], bool):
            raise InvalidProgress("solved must be a boolean")
        record["solved"] = value["solved"]

    for field in _STRING_FIELDS:
        if field not in value:
            continue
        item = value[field]
        if not isinstance(item, str) or len(item) > 80:
            raise InvalidProgress(f"{field} must be a short string")
        if field == "last_result" and item not in _LAST_RESULTS:
            raise InvalidProgress("last_result is invalid")
        record[field] = item

    return record


class PracticeProgressStore:
    """Thread-safe JSON store with atomic replacement on every update."""

    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path).resolve()
        self._lock = threading.RLock()

    @staticmethod
    def empty() -> dict[str, Any]:
        return {"schema": SCHEMA_VERSION, "records": {}}

    def load(self) -> dict[str, Any]:
        with self._lock:
            return self._load_unlocked()

    def _load_unlocked(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return self.empty()
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            logger.error("Could not safely read practice progress %s: %s", self.path, exc)
            raise ProgressStoreUnavailable(
                "Existing practice progress is unreadable; it was left unchanged"
            ) from exc

        if not isinstance(raw, dict) or raw.get("schema") != SCHEMA_VERSION:
            raise ProgressStoreUnavailable(
                "Practice progress uses an unsupported schema; it was left unchanged"
            )
        raw_records = raw.get("records")
        if not isinstance(raw_records, dict):
            raise ProgressStoreUnavailable(
                "Practice progress records are invalid; the file was left unchanged"
            )

        records: dict[str, Any] = {}
        for problem_id, record in raw_records.items():
            try:
                records[validate_problem_id(problem_id)] = validate_record(record)
            except InvalidProgress as exc:
                raise ProgressStoreUnavailable(
                    f"Practice progress record {problem_id!r} is invalid; "
                    "the file was left unchanged"
                ) from exc
        return {"schema": SCHEMA_VERSION, "records": records}

    def update(self, problem_id: str, record: Any) -> dict[str, Any]:
        problem_id = validate_problem_id(problem_id)
        clean_record = validate_record(record)
        with self._lock:
            payload = self._load_unlocked()
            payload["records"][problem_id] = clean_record
            self._write_unlocked(payload)
        return clean_record

    def _write_unlocked(self, payload: Mapping[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.",
            suffix=".tmp",
            dir=self.path.parent,
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, self.path)
        except Exception:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
            raise
