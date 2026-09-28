"""SQLite storage. One connection, used from the event loop thread; every call is short."""
import json
import secrets
import sqlite3
import threading
import time
from typing import Any

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0, last_used_at REAL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, width INTEGER, height INTEGER,
  has_alpha INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, meta TEXT);
CREATE INDEX IF NOT EXISTS assets_path ON assets(path);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, graph TEXT NOT NULL, folder TEXT,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, workflow_id TEXT, name TEXT NOT NULL, graph TEXT NOT NULL,
  folder TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, started_at REAL, finished_at REAL, error TEXT);
CREATE INDEX IF NOT EXISTS runs_workflow ON runs(workflow_id, created_at);
CREATE TABLE IF NOT EXISTS run_nodes (
  run_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
  step INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0, outputs TEXT NOT NULL DEFAULT '[]',
  error TEXT, started_at REAL, finished_at REAL, PRIMARY KEY (run_id, node_id));
CREATE TABLE IF NOT EXISTS trash (
  id TEXT PRIMARY KEY, original_path TEXT NOT NULL, trash_path TEXT NOT NULL, created_at REAL NOT NULL);
"""

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()


def new_id() -> str:
    return secrets.token_urlsafe(9)


def init() -> None:
    global _conn
    config.APP_DIR.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False, isolation_level=None)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA foreign_keys=ON")
    _conn.executescript(SCHEMA)


def execute(sql: str, params: tuple | dict = ()) -> sqlite3.Cursor:
    assert _conn is not None, "db.init() not called"
    with _lock:
        return _conn.execute(sql, params)


def one(sql: str, params: tuple | dict = ()) -> dict[str, Any] | None:
    row = execute(sql, params).fetchone()
    return dict(row) if row else None


def all_rows(sql: str, params: tuple | dict = ()) -> list[dict[str, Any]]:
    return [dict(r) for r in execute(sql, params).fetchall()]


# ---------- settings ----------
def get_setting(key: str, default: Any = None) -> Any:
    row = one("SELECT value FROM settings WHERE key = ?", (key,))
    return json.loads(row["value"]) if row else default


def set_setting(key: str, value: Any) -> None:
    execute("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)))


# ---------- folders ----------
def upsert_folder(path: str, name: str, pinned: bool | None = None, touch: bool = False) -> dict[str, Any]:
    now = time.time()
    row = one("SELECT * FROM folders WHERE path = ?", (path,))
    if row is None:
        execute("INSERT INTO folders(id, path, name, pinned, last_used_at, created_at) VALUES(?, ?, ?, ?, ?, ?)",
                (new_id(), path, name, int(bool(pinned)), now, now))
    else:
        if pinned is not None:
            execute("UPDATE folders SET pinned = ? WHERE id = ?", (int(pinned), row["id"]))
        if touch:
            execute("UPDATE folders SET last_used_at = ? WHERE id = ?", (now, row["id"]))
    return one("SELECT * FROM folders WHERE path = ?", (path,))  # type: ignore[return-value]


# ---------- assets ----------
def insert_asset(path: str, kind: str, width: int, height: int, has_alpha: bool, meta: dict | None = None) -> dict[str, Any]:
    asset_id = new_id()
    execute("INSERT INTO assets(id, path, kind, width, height, has_alpha, created_at, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            (asset_id, path, kind, width, height, int(has_alpha), time.time(), json.dumps(meta or {})))
    return get_asset(asset_id)  # type: ignore[return-value]


def get_asset(asset_id: str) -> dict[str, Any] | None:
    row = one("SELECT * FROM assets WHERE id = ?", (asset_id,))
    if row:
        row["meta"] = json.loads(row["meta"] or "{}")
    return row


def find_upload(sha256: str) -> dict[str, Any] | None:
    """The newest upload with exactly these bytes, so the same picture isn't stored twice."""
    row = one("SELECT id FROM assets WHERE kind = 'upload' AND json_extract(meta, '$.sha256') = ? ORDER BY created_at DESC LIMIT 1",
              (sha256,))
    return get_asset(row["id"]) if row else None


def assets_by_ids(ids: list[str]) -> dict[str, dict[str, Any]]:
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    rows = all_rows(f"SELECT * FROM assets WHERE id IN ({marks})", tuple(ids))
    for r in rows:
        r["meta"] = json.loads(r["meta"] or "{}")
    return {r["id"]: r for r in rows}
