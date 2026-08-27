"""
KataGoEngine — concrete Façade implementation wrapping the KataGo subprocess.

Implements KataGoFacade and hides:
  - subprocess lifecycle (Popen, stdin/stdout/stderr pipes)
  - KataGo Analysis JSON protocol (query construction, ID routing)
  - threading (stdout/stderr daemon reader threads, queue synchronisation)
"""

import subprocess
import threading
import json
import os
import time
import queue
import logging
import re
from collections import deque

from katago_facade import KataGoFacade
from exceptions import EngineNotRunningError, EngineTimeoutError, EngineQueryError

logger = logging.getLogger(__name__)


class KataGoEngine(KataGoFacade):
    """Concrete Façade implementation — wraps the KataGo subprocess."""

    def __init__(
        self,
        katago_path,
        model_path,
        config_path,
        max_wait=300,
        working_dir=None,
    ):
        self.katago_path = katago_path
        self.model_path = model_path
        self.config_path = config_path
        self.max_wait = max_wait
        self.working_dir = working_dir or (os.path.dirname(katago_path) or ".")
        self.report_perspective = self._read_report_perspective(config_path)

        self.process = None
        self.lock = threading.Lock()
        self.response_queues_lock = threading.Lock()
        self.stdin_lock = threading.Lock()
        self.response_queues = {}  # id -> Queue
        self.reader_thread = None
        self.running = False
        self.ready = False
        self.query_counter = 0
        self.stderr_tail = deque(maxlen=80)

    def _mark_engine_unavailable(self, reason):
        """Mark the engine unavailable and wake every pending query.

        Queue registration and failure are coordinated by the same lock.  This
        prevents a query from being registered immediately after an stdout EOF
        has taken the pending-queue snapshot and then waiting until max_wait.
        """
        with self.response_queues_lock:
            self.running = False
            self.ready = False
            pending_queues = list(self.response_queues.values())
            self.response_queues.clear()

        for pending_queue in pending_queues:
            pending_queue.put(EngineNotRunningError(reason))

    @staticmethod
    def _is_intermediate_response(response):
        """Return whether a KataGo message is not the final query result."""
        if response.get("isDuringSearch"):
            return True

        # KataGo can emit an id-scoped warning before the actual result.  A
        # warning attached to a normal result must not make us drop that result.
        result_fields = ("rootInfo", "moveInfos", "ownership", "policy")
        return (
            "warning" in response
            and "error" not in response
            and not any(field in response for field in result_fields)
        )

    @staticmethod
    def _read_report_perspective(config_path):
        """Read KataGo's configured analysis reporting perspective."""
        perspective = "BLACK"
        try:
            with open(config_path, "r", encoding="utf-8") as cfg:
                for line in cfg:
                    match = re.match(
                        r"^\s*reportAnalysisWinratesAs\s*=\s*"
                        r"(BLACK|WHITE|SIDETOMOVE)\b",
                        line.split("#", 1)[0],
                        flags=re.IGNORECASE,
                    )
                    if match:
                        perspective = match.group(1).upper()
        except OSError:
            logger.warning(
                "Could not read analysis perspective from %s; assuming BLACK",
                config_path,
            )
        return perspective

    def _to_black_perspective(self, winrate, score_lead, current_player):
        """Normalize KataGo values to black win probability / black lead."""
        if self._should_invert_perspective(current_player):
            return 1.0 - winrate, -score_lead
        return winrate, score_lead

    def _should_invert_perspective(self, current_player):
        """Return whether configured values need inversion to black's view."""
        return self.report_perspective == "WHITE" or (
            self.report_perspective == "SIDETOMOVE"
            and str(current_player).upper() == "W"
        )

    def start(self):
        """Launch the KataGo process and wait until it passes the readiness probe."""
        if self.process and self.process.poll() is None:
            if self.running:
                logger.warning("KataGo is already running")
                return True

            # stdout may have failed just before the OS process exits.  Do not
            # report that dead connection as healthy on a restart attempt.
            stale_process = self.process
            logger.warning("Replacing KataGo process with unavailable stdout")
            try:
                stale_process.terminate()
                stale_process.wait(timeout=5)
            except Exception:
                stale_process.kill()

        cmd = [
            self.katago_path,
            "analysis",
            "-model", self.model_path,
            "-config", self.config_path,
        ]

        logger.info(f"Starting KataGo: {' '.join(cmd)}")

        try:
            os.makedirs(self.working_dir, exist_ok=True)
            self.stderr_tail.clear()
            self.process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self.working_dir,
            )
        except FileNotFoundError:
            logger.error(f"KataGo executable not found: {self.katago_path}")
            return False
        except Exception as e:
            logger.error(f"Failed to start KataGo: {e}")
            return False

        with self.response_queues_lock:
            self.running = True

        process = self.process
        self.reader_thread = threading.Thread(
            target=self._read_stdout, args=(process,), daemon=True
        )
        self.reader_thread.start()

        self.stderr_thread = threading.Thread(
            target=self._read_stderr, args=(process,), daemon=True
        )
        self.stderr_thread.start()

        logger.info("Waiting for KataGo engine to become ready "
                    "(first run may take several minutes for OpenCL tuning)...")
        # Wait for the process to stabilise before sending the probe.
        for i in range(60):
            time.sleep(2)
            if self.process.poll() is not None:
                stderr_out = (self.process.stderr.read().decode("utf-8", errors="replace")
                              if self.process.stderr else "")
                logger.error(f"KataGo process exited unexpectedly "
                             f"(code={self.process.returncode})")
                if stderr_out:
                    logger.error(f"KataGo stderr: {stderr_out[:2000]}")
                return False
            if i >= 2:  # give at least 4 s before sending the probe
                break

        logger.info("Sending readiness probe...")
        try:
            self.query(
                moves=[],
                board_size=9,
                komi=7.5,
                max_visits=1,
                query_id="__startup_test__",
            )
            self.ready = True
            logger.info("KataGo engine is ready")
            return True
        except Exception as e:
            logger.error(f"KataGo engine startup failed: {e}")
            self.stop()
            return False

    def stop(self):
        """Gracefully terminate the KataGo process."""
        self._mark_engine_unavailable("KataGo engine was stopped")
        process = self.process
        if process and process.poll() is None:
            try:
                with self.stdin_lock:
                    process.stdin.close()
                process.terminate()
                process.wait(timeout=5)
            except Exception:
                process.kill()
            logger.info("KataGo stopped")

    def _read_stdout(self, process=None):
        """Background thread: read newline-delimited JSON responses from stdout."""
        process = process or self.process
        failure_reason = None
        try:
            if process is None or process.stdout is None:
                raise RuntimeError("KataGo stdout pipe is unavailable")

            while True:
                line = process.stdout.readline()
                if not line:
                    if process is self.process and self.running:
                        # Give Windows a brief moment to publish the process
                        # exit code and let the stderr reader drain its pipe.
                        return_code = process.poll()
                        if return_code is None and hasattr(process, "wait"):
                            try:
                                return_code = process.wait(timeout=0.25)
                            except (subprocess.TimeoutExpired, TypeError):
                                return_code = None
                        failure_reason = "KataGo stdout closed unexpectedly"
                        if return_code is not None:
                            unsigned_code = int(return_code) & 0xFFFFFFFF
                            failure_reason += (
                                f" (exit code {return_code}, 0x{unsigned_code:08X})"
                            )
                        if self.stderr_tail:
                            logger.error(
                                "KataGo stderr tail before exit:\n%s",
                                "\n".join(list(self.stderr_tail)[-20:]),
                            )
                    break
                if process is not self.process or not self.running:
                    break
                if isinstance(line, bytes):
                    line = line.decode("utf-8", errors="replace")
                line = line.strip()
                if not line:
                    continue
                try:
                    response = json.loads(line)
                    if self._is_intermediate_response(response):
                        logger.debug(
                            "Ignoring intermediate response for query id: %s",
                            response.get("id", ""),
                        )
                        continue
                    query_id = response.get("id", "")
                    with self.response_queues_lock:
                        response_queue = self.response_queues.get(query_id)
                    if response_queue is not None:
                        response_queue.put(response)
                    else:
                        logger.debug(f"Received response for unknown query id: {query_id}")
                except json.JSONDecodeError:
                    logger.debug(f"Non-JSON stdout line: {line}")
        except Exception as e:
            if process is self.process and self.running:
                failure_reason = f"Error reading KataGo stdout: {e}"
        finally:
            if failure_reason and process is self.process:
                logger.error(failure_reason)
                self._mark_engine_unavailable(failure_reason)

    def _read_stderr(self, process=None):
        """Background thread: forward KataGo stderr to the Python logger."""
        process = process or self.process
        try:
            if process is None or process.stderr is None:
                return
            for line in process.stderr:
                if process is not self.process or not self.running:
                    break
                line = line.decode("utf-8", errors="replace").strip()
                if line:
                    self.stderr_tail.append(line)
                    logger.debug(f"[KataGo] {line}")
        except Exception:
            pass

    def _next_id(self):
        """Return a unique query id (thread-safe)."""
        with self.lock:
            self.query_counter += 1
            return f"q_{self.query_counter}"

    def query(self, moves, board_size=19, komi=7.5, max_visits=3000,
              rules="chinese", query_id=None, analyze_turns=None,
              initial_stones=None, initial_player=None,
              include_ownership=False, include_policy=False):
        """
        Send a raw analysis query to KataGo and return the JSON response dict.

        Raises:
            EngineNotRunningError: process not alive or stdin write failed.
            EngineTimeoutError:    no response within max_wait seconds.
        """
        if query_id is None:
            query_id = self._next_id()

        query_obj = {
            "id": query_id,
            "moves": moves,
            "rules": rules,
            "komi": komi,
            "boardXSize": board_size,
            "boardYSize": board_size,
            "maxVisits": max_visits,
        }

        if initial_stones:
            query_obj["initialStones"] = initial_stones

        if initial_player:
            query_obj["initialPlayer"] = initial_player

        if analyze_turns is not None:
            query_obj["analyzeTurns"] = analyze_turns

        if include_ownership:
            query_obj["includeOwnership"] = True

        if include_policy:
            query_obj["includePolicy"] = True

        resp_queue = queue.Queue()
        with self.response_queues_lock:
            process = self.process
            if (
                not self.running
                or process is None
                or process.poll() is not None
            ):
                raise EngineNotRunningError("KataGo process is not running")
            if query_id in self.response_queues:
                raise EngineQueryError(f"Duplicate KataGo query id: {query_id}")
            self.response_queues[query_id] = resp_queue

        query_json = json.dumps(query_obj) + "\n"
        try:
            with self.stdin_lock:
                if process is not self.process or not self.running:
                    raise BrokenPipeError("KataGo stopped before query was sent")
                process.stdin.write(query_json.encode("utf-8"))
                process.stdin.flush()
        except Exception as e:
            logger.error(f"Failed to send query to KataGo: {e}")
            if process is self.process:
                self._mark_engine_unavailable(
                    f"KataGo stdin became unavailable: {e}"
                )
            else:
                with self.response_queues_lock:
                    self.response_queues.pop(query_id, None)
            raise EngineNotRunningError(f"Failed to write to KataGo stdin: {e}") from e

        # Wait for response
        try:
            response = resp_queue.get(timeout=self.max_wait)
            if isinstance(response, EngineNotRunningError):
                raise response
            return response
        except queue.Empty:
            logger.warning(f"Query {query_id} timed out after {self.max_wait}s")
            # Ask KataGo to drop this query. Otherwise abandoned (timed-out)
            # queries keep computing and pile up in the engine's queue: while the
            # engine is slow or recovering, later queries wait behind a growing
            # backlog and keep timing out, so it never catches up. Best-effort —
            # terminate() checks the process and swallows its own errors.
            self.terminate(query_id)
            raise EngineTimeoutError(
                f"KataGo did not respond within {self.max_wait}s"
            )
        finally:
            with self.response_queues_lock:
                self.response_queues.pop(query_id, None)

    def terminate(self, query_id) -> None:
        """
        Best-effort: ask KataGo to stop computing the query with *query_id*.

        Sends the Analysis-Engine "terminate" action.  Used to abort an
        in-flight analysis when the board position changes, so the engine
        can devote its full search budget to the latest position instead
        of finishing stale work.  Errors are swallowed — termination is
        an optimisation, never required for correctness.
        """
        process = self.process
        if not self.running or not process or process.poll() is not None:
            return
        cmd = {
            "id":          f"terminate_{query_id}",
            "action":      "terminate",
            "terminateId": query_id,
        }
        try:
            with self.stdin_lock:
                if process is not self.process or not self.running:
                    return
                process.stdin.write((json.dumps(cmd) + "\n").encode("utf-8"))
                process.stdin.flush()
            logger.debug(f"Sent terminate for query {query_id}")
        except Exception as e:
            logger.debug(f"terminate({query_id}) failed: {e}")

    def analyze_position(self, moves, board_size=19, komi=7.5,
                         max_visits=3000, include_ownership=False,
                         initial_stones=None, initial_player=None,
                         query_id=None):
        """
        Analyse a Go position and return ranked candidate moves.

        Returns a dict with keys:
            currentPlayer  "B" or "W"
            winrate        black win probability (0–1)
            scoreLead      black score lead (positive = black ahead)
            visits         total MCTS visits used
            moves          list of candidate dicts (move, visits, winrate,
                           scoreLead, order, pv, prior)
            ownership      list of per-intersection values (if requested)

        Args:
            query_id: optional explicit id so the caller can later
                      terminate() this specific query.

        Raises:
            EngineNotRunningError, EngineTimeoutError, EngineQueryError
        """
        result = self.query(
            moves=moves,
            board_size=board_size,
            komi=komi,
            max_visits=max_visits,
            include_ownership=include_ownership,
            initial_stones=initial_stones,
            initial_player=initial_player,
            query_id=query_id,
        )

        if "error" in result:
            msg = result["error"]
            logger.error(f"KataGo returned an error: {msg}")
            raise EngineQueryError(msg)

        move_infos    = result.get("moveInfos", [])
        root_info     = result.get("rootInfo", {})
        current_player = root_info.get("currentPlayer", "B")

        # Normalize the configured reporting perspective to the frontend's
        # stable black-perspective contract.
        raw_winrate    = root_info.get("winrate", 0.5)
        raw_score_lead = root_info.get("scoreLead", 0.0)
        black_winrate, black_score_lead = self._to_black_perspective(
            raw_winrate, raw_score_lead, current_player
        )

        parsed = {
            "currentPlayer": current_player,
            "winrate":       black_winrate,
            "scoreLead":     black_score_lead,
            "visits":        root_info.get("visits", 0),
            "moves": [],
        }

        for mi in move_infos:
            move_winrate, move_score_lead = self._to_black_perspective(
                mi.get("winrate", 0.5), mi.get("scoreLead", 0.0), current_player
            )
            parsed["moves"].append({
                "move":      mi.get("move", "pass"),
                "visits":    mi.get("visits", 0),
                "winrate":   move_winrate,
                "scoreLead": move_score_lead,
                "order":     mi.get("order", 0),
                "pv":        mi.get("pv", []),
                "prior":     mi.get("prior", 0.0),
            })

        if include_ownership and "ownership" in result:
            ownership = result["ownership"]
            if self._should_invert_perspective(current_player):
                ownership = [-value for value in ownership]
            parsed["ownership"] = ownership

        return parsed

    def is_running(self) -> bool:
        """Return True if the KataGo process is alive and has passed the readiness probe."""
        return self.process is not None and self.process.poll() is None and self.ready
