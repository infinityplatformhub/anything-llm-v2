"""Synthetic full-schema recovery rehearsal only; never loads app environment."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from contextlib import closing

sys.path.insert(0, str(Path(__file__).parents[1]))
from snapshot import capture_snapshot, export_snapshot
from storage import capture_storage, restore_storage

request = json.loads(Path(sys.argv[1]).read_text())
root = Path(request["directory"])
contract = request["contract"]

if request["mode"] == "capture":
    storage = root / "storage"
    storage.mkdir()
    (storage / "documents").mkdir()
    (storage / "documents" / "ไทย.txt").write_text("synthetic restoration ไทย")
    (storage / ".env").write_text("SYNTHETIC_CONFIG_ONLY=true\n")
    (storage / ".env").chmod(0o600)
    source = storage / "anythingllm.db"
    with closing(sqlite3.connect(source)) as db, db:
        if "migrations" in request:
            for migration in sorted(Path(request["migrations"]).glob("*/migration.sql")):
                db.executescript(migration.read_text())
        else:
            db.executescript(Path(request["ddl"]).read_text())
        db.execute("PRAGMA foreign_keys=ON")
        for table in contract["tables"]:
            for row in request["rows"].get(table["name"], []):
                names = list(row)
                sql = 'INSERT INTO "' + table["name"] + '" (' + ','.join('"' + name + '"' for name in names) + ') VALUES (' + ','.join('?' for name in names) + ')'
                db.execute(sql, [row[name] for name in names])
        db.execute("UPDATE sqlite_sequence SET seq=500 WHERE name='users'")
    snapshot = root / "sqlite.db"
    captured = capture_snapshot(source, snapshot)
    archived = capture_storage(storage, root / "storage.tar", ["anythingllm.db", "anythingllm.db-wal", "anythingllm.db-shm"])
    print(json.dumps({"snapshot": captured, "storage": archived}))
elif request["mode"] == "restore-export":
    recovered_storage = root / "restored-storage"
    restore_storage(Path(request["archive"]), recovered_storage, request["archiveSha256"])
    assert (recovered_storage / "documents" / "ไทย.txt").read_text() == "synthetic restoration ไทย"
    assert (recovered_storage / ".env").read_text() == "SYNTHETIC_CONFIG_ONLY=true\n"
    print(json.dumps(export_snapshot(Path(request["snapshot"]), root / "restored-export.ndjson", contract, request["snapshotSha256"])))
else:
    raise ValueError("Unsupported fixture mode")
