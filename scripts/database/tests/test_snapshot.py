import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
import sys
sys.path.insert(0, str(Path(__file__).parents[1]))


def snapshot_module():
    spec = importlib.util.spec_from_file_location(
        "migration_snapshot", Path(__file__).parents[1] / "snapshot.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="anythingllm-snapshot-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.db"
        self.connection = sqlite3.connect(self.source)
        self.addCleanup(self.connection.close)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA wal_autocheckpoint=0")
        self.connection.execute(
            "CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT)"
        )
        self.connection.execute("INSERT INTO records(content) VALUES ('fixture Unicode ไทย')")
        self.connection.commit()

    def test_captures_committed_wal_and_preserves_original(self):
        self.assertTrue(Path(str(self.source) + "-wal").exists())
        before = self.source.read_bytes()
        target = self.root / "snapshot.db"
        result = snapshot_module().capture_snapshot(self.source, target)
        with closing(sqlite3.connect(target)) as restored:
            self.assertEqual(
                restored.execute("SELECT content FROM records").fetchall(),
                [("fixture Unicode ไทย",)],
            )
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(result["integrity"], "ok")
        self.assertEqual(result["sha256"], __import__("hashlib").sha256(target.read_bytes()).hexdigest())
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_excludes_uncommitted_writes(self):
        self.connection.execute("INSERT INTO records(content) VALUES ('uncommitted')")
        target = self.root / "snapshot.db"
        snapshot_module().capture_snapshot(self.source, target)
        with closing(sqlite3.connect(target)) as restored:
            self.assertEqual(restored.execute("SELECT COUNT(*) FROM records").fetchone()[0], 1)

    def test_preserves_deleted_high_id_sequence(self):
        self.connection.execute("INSERT INTO records(id,content) VALUES (500,'deleted')")
        self.connection.execute("DELETE FROM records WHERE id=500")
        self.connection.commit()
        target = self.root / "snapshot.db"
        snapshot_module().capture_snapshot(self.source, target)
        with closing(sqlite3.connect(target)) as restored:
            self.assertEqual(restored.execute("SELECT seq FROM sqlite_sequence WHERE name='records'").fetchone()[0], 500)

    def test_refuses_existing_destination_without_overwriting(self):
        target = self.root / "snapshot.db"
        target.write_bytes(b"protected-fixture")
        with self.assertRaises(FileExistsError):
            snapshot_module().capture_snapshot(self.source, target)
        self.assertEqual(target.read_bytes(), b"protected-fixture")

    def test_refuses_source_as_destination(self):
        with self.assertRaises(ValueError):
            snapshot_module().capture_snapshot(self.source, self.source)

    def test_refuses_symlink_source_or_destination(self):
        alias = self.root / "alias.db"
        alias.symlink_to(self.source)
        with self.assertRaises(ValueError):
            snapshot_module().capture_snapshot(alias, self.root / "snapshot.db")
        with self.assertRaises(ValueError):
            snapshot_module().capture_snapshot(self.source, alias)

    def test_missing_source_is_not_created(self):
        module = snapshot_module()
        missing = self.root / "missing.db"
        with self.assertRaises(FileNotFoundError):
            module.capture_snapshot(missing, self.root / "snapshot.db")
        self.assertFalse(missing.exists())

    def test_foreign_key_violation_rejects_success(self):
        self.connection.executescript(
            "CREATE TABLE parent(id INTEGER PRIMARY KEY);"
            "CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id));"
            "INSERT INTO child VALUES(1,999);"
        )
        with self.assertRaisesRegex(ValueError, "foreign key"):
            snapshot_module().capture_snapshot(self.source, self.root / "snapshot.db")

    def test_corrupt_source_rejects_success(self):
        corrupt = self.root / "corrupt.db"
        corrupt.write_bytes(b"not-a-database")
        with self.assertRaises(sqlite3.DatabaseError):
            snapshot_module().capture_snapshot(corrupt, self.root / "snapshot.db")

    def test_refuses_symlink_parent_paths(self):
        parent = self.root / "linked-parent"
        parent.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            snapshot_module().capture_snapshot(parent / "source.db", self.root / "snapshot.db")
        with self.assertRaises(ValueError):
            snapshot_module().capture_snapshot(self.source, parent / "snapshot.db")


if __name__ == "__main__":
    unittest.main()
