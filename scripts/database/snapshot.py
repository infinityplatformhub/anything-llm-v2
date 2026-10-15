"""WAL-aware SQLite snapshot primitive; does not establish a DB/files freeze.

No production CLI is exposed yet. The later capture operator must independently
verify that all DB and storage writers are frozen before packaging a recovery set.
"""

import hashlib
import datetime
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time
from paths import protected_path


def capture_snapshot(source, destination, timeout_seconds=30):
    source = protected_path(source)
    destination = protected_path(destination)
    if source.is_symlink() or destination.is_symlink():
        raise ValueError("Snapshot paths must not be symlinks")
    if source.resolve() == destination.resolve():
        raise ValueError("Snapshot destination must differ from source")
    if not source.is_file():
        raise FileNotFoundError("Snapshot source must already exist")
    if timeout_seconds <= 0:
        raise ValueError("Snapshot timeout must be positive")
    # Exclusive creation prevents overwriting caller data. Failed snapshots are
    # retained without a success manifest, rather than deleted or retried.
    fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    deadline = time.monotonic() + timeout_seconds

    def progress(status, remaining, total):
        if time.monotonic() >= deadline:
            raise TimeoutError("SQLite snapshot capture timed out")

    original = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=1)
    target = sqlite3.connect(destination)
    try:
        original.backup(target, pages=256, progress=progress, sleep=0.05)
        target.commit()
        if target.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("Snapshot integrity check failed")
        if target.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("Snapshot foreign key check failed")
    finally:
        target.close()
        original.close()
    with destination.open("rb") as payload:
        digest = hashlib.file_digest(payload, "sha256").hexdigest()
    return {"sha256": digest, "size": destination.stat().st_size, "integrity": "ok"}


def _sha256(path):
    with Path(path).open("rb") as payload:
        return hashlib.file_digest(payload, "sha256").hexdigest()


def _identifier(name):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError("Invalid schema identifier")
    return '"' + name + '"'


def _tag_value(value, storage_type, column):
    kind = column["type"]
    if value is None:
        if not column["nullable"]:
            raise ValueError("Unexpected null in required column")
        return ["null", None]
    if kind == "Int":
        if storage_type != "integer" or not -2147483648 <= value <= 2147483647:
            raise ValueError("Unsupported Int value")
        return [kind, str(value)]
    if kind == "Boolean":
        if storage_type != "integer" or value not in (0, 1):
            raise ValueError("Unsupported Boolean value")
        return [kind, bool(value)]
    if kind == "String":
        if storage_type != "text" or "\x00" in value:
            raise ValueError("Unsupported String value")
        value.encode("utf-8", errors="strict")
        return [kind, value]
    if kind == "Float":
        if storage_type not in ("integer", "real") or not math.isfinite(value):
            raise ValueError("Unsupported Float value")
        if storage_type == "integer" and int(float(value)) != value:
            raise ValueError("Unsupported Float precision")
        return [kind, repr(float(value))]
    if kind == "DateTime":
        try:
            if storage_type == "integer":
                instant = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(milliseconds=value)
            elif storage_type == "text" and re.fullmatch(
                r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?", value
            ):
                instant = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
                # SQLite CURRENT_TIMESTAMP is UTC but omits the offset.
                if instant.tzinfo is None:
                    instant = instant.replace(tzinfo=datetime.timezone.utc)
                instant = instant.astimezone(datetime.timezone.utc)
            else:
                raise ValueError()
            return [kind, instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")]
        except (ValueError, OverflowError):
            raise ValueError("Unsupported DateTime representation or precision") from None
    raise ValueError("Unsupported scalar type")


def export_snapshot(source, destination, contract, expected_sha256):
    """Export only a closed immutable snapshot, never an active application DB.

    Values are tagged, ordered and bounded; plaintext export is a sensitive
    intermediate that must remain on protected storage and be encrypted later.
    """
    source = protected_path(source)
    destination = protected_path(destination)
    if source.is_symlink() or destination.is_symlink() or source.resolve() == destination.resolve():
        raise ValueError("Invalid snapshot export paths")
    if not source.is_file():
        raise FileNotFoundError("Snapshot must exist")
    if any(Path(str(source) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise ValueError("Export requires a closed SQLite snapshot")
    if _sha256(source) != expected_sha256:
        raise ValueError("Snapshot identity does not match")
    if contract.get("version") != 1 or not contract.get("tables"):
        raise ValueError("Unsupported schema contract")
    encoded_contract = json.dumps(contract, separators=(",", ":"), ensure_ascii=False).encode()
    contract_hash = hashlib.sha256(encoded_contract).hexdigest()
    connection = sqlite3.connect(source.as_uri() + "?mode=ro&immutable=1", uri=True)
    counts = {}
    try:
        connection.execute("PRAGMA query_only=ON")
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)] or connection.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError("Snapshot integrity or foreign key check failed")
        actual_tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        expected_tables = {table["name"] for table in contract["tables"]}
        if actual_tables - {"_prisma_migrations"} != expected_tables:
            raise ValueError("Source schema tables do not match")
        # Full production contract requires original index/default/FK/trigger
        # reconciliation, not just matching column names. Minimal unit contracts
        # stay synthetic-only and cannot be accepted by the PG importer.
        if any(table["name"] == "users" for table in contract["tables"]):
            from source_schema import verify_source_schema
            verify_source_schema(connection, Path(__file__).parents[2] / "server/prisma/migrations")
        for table in contract["tables"]:
            columns = connection.execute("PRAGMA table_info(" + _identifier(table["name"]) + ")").fetchall()
            if {row[1] for row in columns} != {column["name"] for column in table["columns"]}:
                raise ValueError("Source schema columns do not match")
            if [row[1] for row in sorted(columns, key=lambda row: row[5]) if row[5]] != table["primaryKey"]:
                raise ValueError("Source schema primary key does not match")
        fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            def emit(value):
                output.write(json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n")
            emit({"kind": "header", "version": 1, "sourceSha256": expected_sha256, "contractSha256": contract_hash})
            has_sequence = connection.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone()
            for table in contract["tables"]:
                name = table["name"]
                sequence = None
                if table["sequenceColumn"] and has_sequence:
                    row = connection.execute("SELECT seq FROM sqlite_sequence WHERE name=?", (name,)).fetchone()
                    sequence = str(row[0]) if row else None
                    if row and (type(row[0]) is not int or not 0 <= row[0] <= 2147483647):
                        raise ValueError("Unsupported sequence high-water mark")
                emit({"kind": "table", "name": name, "sequence": sequence})
                columns = table["columns"]
                selection = ",".join(_identifier(column["name"]) for column in columns)
                types = ",".join("typeof(" + _identifier(column["name"]) + ")" for column in columns)
                ordering = ",".join(_identifier(key) for key in table["primaryKey"])
                cursor = connection.execute("SELECT " + selection + "," + types + " FROM " + _identifier(name) + " ORDER BY " + ordering)
                counts[name] = 0
                for row in cursor:
                    values = [_tag_value(row[i], row[len(columns) + i], column) for i, column in enumerate(columns)]
                    emit({"kind": "row", "table": name, "values": values})
                    counts[name] += 1
                emit({"kind": "end", "table": name, "count": counts[name]})
            if _sha256(source) != expected_sha256:
                raise ValueError("Snapshot identity changed during export")
            emit({"kind": "complete", "counts": counts})
            output.flush()
            os.fsync(output.fileno())
    finally:
        connection.close()
    return {"sha256": _sha256(destination), "counts": counts, "contractSha256": contract_hash}
