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

from katago_facade import KataGoFacade
from exceptions import EngineNotRunningError, EngineTimeoutError, EngineQueryError

logger = logging.getLogger(__name__)


class KataGoEngine(KataGoFacade):
    """Concrete Façade implementation — wraps the KataGo subprocess."""

    def __init__(self, katago_path, model_path, config_path, max_wait=300):
        self.katago_path = katago_path
        self.model_path = model_path
        self.config_path = config_path
        self.max_wait = max_wait

        self.process = None
        self.lock = threading.Lock()
        self.response_queues = {}  # id -> Queue
        self.reader_thread = None
        self.running = False
        self.ready = False
        self.query_counter = 0

    def start(self):
        """Launch the KataGo process and wait until it passes the readiness probe."""
        if self.process and self.process.poll() is None:
            logger.warning("KataGo is already running")
            return True

        cmd = [
            self.katago_path,
            "analysis",
            "-model", self.model_path,
            "-config", self.config_path,
        ]

        logger.info(f"Starting KataGo: {' '.join(cmd)}")

        try:
            self.process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=os.path.dirname(self.katago_path) or ".",
            )
        except FileNotFoundError:
            logger.error(f"KataGo executable not found: {self.katago_path}")
            return False
        except Exception as e:
            logger.error(f"Failed to start KataGo: {e}")
            return False

        self.running = True

        self.reader_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self.reader_thread.start()

        self.stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
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
        self.running = False
        if self.process and self.process.poll() is None:
            try:
                self.process.stdin.close()
                self.process.terminate()
                self.process.wait(timeout=5)
            except Exception:
                self.process.kill()
            logger.info("KataGo stopped")
        self.ready = False

    def _read_stdout(self):
        """Background thread: read newline-delimited JSON responses from stdout."""
        try:
            for line in self.process.stdout:
                if not self.running:
                    break
                line = line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    response = json.loads(line)
                    query_id = response.get("id", "")
                    if query_id in self.response_queues:
                        self.response_queues[query_id].put(response)
                    else:
                        logger.debug(f"Received response for unknown query id: {query_id}")
                except json.JSONDecodeError:
                    logger.debug(f"Non-JSON stdout line: {line}")
        except Exception as e:
            if self.running:
                logger.error(f"Error reading KataGo stdout: {e}")

    def _read_stderr(self):
        """Background thread: forward KataGo stderr to the Python logger."""
        try:
            for line in self.process.stderr:
                if not self.running:
                    break
                line = line.decode("utf-8").strip()
                if line:
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
        if not self.process or self.process.poll() is not None:
            raise EngineNotRunningError("KataGo process is not running")

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
        self.response_queues[query_id] = resp_queue

        query_json = json.dumps(query_obj) + "\n"
        try:
            self.process.stdin.write(query_json.encode("utf-8"))
            self.process.stdin.flush()
        except Exception as e:
            logger.error(f"Failed to send query to KataGo: {e}")
            del self.response_queues[query_id]
            raise EngineNotRunningError(f"Failed to write to KataGo stdin: {e}") from e

        # Wait for response
        try:
            response = resp_queue.get(timeout=self.max_wait)
            return response
        except queue.Empty:
            logger.warning(f"Query {query_id} timed out after {self.max_wait}s")
            raise EngineTimeoutError(
                f"KataGo did not respond within {self.max_wait}s"
            )
        finally:
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
        if not self.process or self.process.poll() is not None:
            return
        cmd = {
            "id":          f"terminate_{query_id}",
            "action":      "terminate",
            "terminateId": query_id,
        }
        try:
            self.process.stdin.write((json.dumps(cmd) + "\n").encode("utf-8"))
            self.process.stdin.flush()
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

        # KataGo reports winrate and scoreLead from the current player's
        # perspective.  Normalise to black's perspective so the frontend
        # can display them unconditionally as "black winrate / black lead".
        raw_winrate    = root_info.get("winrate", 0.5)
        raw_score_lead = root_info.get("scoreLead", 0.0)
        if current_player == "W":
            black_winrate    = 1.0 - raw_winrate
            black_score_lead = -raw_score_lead
        else:
            black_winrate    = raw_winrate
            black_score_lead = raw_score_lead

        parsed = {
            "currentPlayer": current_player,
            "winrate":       black_winrate,
            "scoreLead":     black_score_lead,
            "visits":        root_info.get("visits", 0),
            "moves": [],
        }

        for mi in move_infos:
            parsed["moves"].append({
                "move":      mi.get("move", "pass"),
                "visits":    mi.get("visits", 0),
                "winrate":   mi.get("winrate", 0.5),
                "scoreLead": mi.get("scoreLead", 0.0),
                "order":     mi.get("order", 0),
                "pv":        mi.get("pv", []),
                "prior":     mi.get("prior", 0.0),
            })

        if include_ownership and "ownership" in result:
            parsed["ownership"] = result["ownership"]

        return parsed

    def is_running(self) -> bool:
        """Return True if the KataGo process is alive and has passed the readiness probe."""
        return self.process is not None and self.process.poll() is None and self.ready
