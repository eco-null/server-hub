"""SQLite access: one serialized connection, numbered SQL migrations.

All statements run in a worker thread (``await db.run(fn, ...)``) so the event
loop never blocks on disk I/O or the busy timeout. A lock serializes access to
the single connection; for a self-hosted dashboard that is plenty and keeps
transactions simple and consistent.
"""

from __future__ import annotations

import contextlib
import logging
import re
import shutil
import sqlite3
import tempfile
import threading
from collections.abc import Callable, Iterator
from importlib import resources
from pathlib import Path
from typing import Any, ParamSpec, TypeVar

import anyio.to_thread

log = logging.getLogger(__name__)

P = ParamSpec("P")
T = TypeVar("T")

_MIGRATION_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


@contextlib.contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """BEGIN IMMEDIATE ... COMMIT, rolling back on any exception."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def _migrations() -> list[tuple[int, str, str]]:
    found = []
    pkg = resources.files("serverhub.db") / "migrations"
    for entry in pkg.iterdir():
        m = _MIGRATION_RE.match(entry.name)
        if m:
            found.append((int(m.group(1)), entry.name, entry.read_text(encoding="utf-8")))
    found.sort()
    for i, (num, name, _) in enumerate(found, start=1):
        if num != i:
            raise RuntimeError(f"migration numbering gap at {name}")
    return found


def migrate(conn: sqlite3.Connection) -> int:
    """Apply pending migrations; returns the resulting schema version."""
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    migrations = _migrations()
    if current > len(migrations):
        raise RuntimeError(
            f"database schema version {current} is newer than this build supports "
            f"({len(migrations)}); refusing to start"
        )
    for num, name, sql in migrations:
        if num <= current:
            continue
        log.info("applying migration %s", name)
        # executescript() commits implicitly, so wrap the script in its own
        # transaction and bump user_version inside it.
        conn.executescript(f"BEGIN IMMEDIATE;\n{sql}\nPRAGMA user_version = {num};\nCOMMIT;")
    return conn.execute("PRAGMA user_version").fetchone()[0]


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn = connect(path)
        self._lock = threading.Lock()
        with self._lock:
            migrate(self._conn)

    def call(self, fn: Callable[..., T], *args: Any) -> T:
        """Run ``fn(conn, *args)`` synchronously under the connection lock."""
        with self._lock:
            return fn(self._conn, *args)

    async def run(self, fn: Callable[..., T], *args: Any) -> T:
        """Run ``fn(conn, *args)`` in a worker thread."""
        return await anyio.to_thread.run_sync(self.call, fn, *args)

    def close(self) -> None:
        with self._lock:
            with contextlib.suppress(sqlite3.Error):
                self._conn.execute("PRAGMA optimize")
            self._conn.close()


def backup_to(src: Path, dest: Path) -> None:
    """Write a consistent copy of the database at ``src`` to ``dest``."""
    if dest.exists() and src.samefile(dest):
        raise ValueError("Back up to a file separate from the live database")
    dest.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(src)
    try:
        target = sqlite3.connect(dest)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()


def _has_sidecars(path: Path) -> bool:
    return any(
        path.with_name(path.name + suffix).exists() for suffix in ("-wal", "-shm", "-journal")
    )


def _table_columns(conn: sqlite3.Connection) -> set[tuple[str, str]]:
    return {
        (table, column)
        for table, column in conn.execute(
            "SELECT s.name, c.name FROM sqlite_schema AS s"
            " JOIN pragma_table_info(s.name) AS c WHERE s.type = 'table'"
        )
    }


def verify_backup(path: Path) -> int:
    """Check a standalone Server Hub SQLite snapshot without writing to it."""
    if not path.is_file():
        raise ValueError(f"No backup at {path}")
    if _has_sidecars(path):
        raise ValueError("Use a standalone backup file made with the backup command")
    uri = path.resolve().as_uri() + "?mode=ro&immutable=1"
    with contextlib.closing(sqlite3.connect(uri, uri=True)) as conn:
        conn.execute("PRAGMA trusted_schema = OFF")
        if conn.execute("PRAGMA integrity_check(1)").fetchone() != ("ok",):
            raise ValueError("SQLite integrity check failed")
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version < 1:
            raise ValueError("This file is not a Server Hub backup")
        migrations = _migrations()
        if version > len(migrations):
            raise ValueError(f"Backup schema version {version} requires a newer Server Hub")
        with contextlib.closing(sqlite3.connect(":memory:")) as expected:
            for _, _, sql in migrations[:version]:
                expected.executescript(sql)
            if not _table_columns(expected).issubset(_table_columns(conn)):
                raise ValueError("Server Hub backup has an incomplete schema")
        if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("SQLite foreign-key check failed")
    return version


def restore_backup(src: Path, dest: Path) -> int:
    """Stage and verify a snapshot before atomically replacing a stopped server's database."""
    if src.resolve() == dest.resolve() or _has_sidecars(src):
        raise ValueError("Restore from a standalone backup separate from the live database")
    if _has_sidecars(dest):
        raise ValueError("The database has journal files. Stop the server cleanly before restoring")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest.parent) as staging:
        staged = Path(staging) / dest.name
        staged.touch(mode=0o600)
        shutil.copyfile(src, staged)
        version = verify_backup(staged)
        if _has_sidecars(dest):
            raise ValueError("The database became active during restore. Stop the server and retry")
        staged.replace(dest)
    return version
