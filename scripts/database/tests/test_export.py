import hashlib
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import sys
sys.path.insert(0, str(Path(__file__).parents[1]))


def load_module():
    spec = importlib.util.spec_from_file_location("snapshot_export", Path(__file__).parents[1] / "snapshot.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CONTRACT = {"version": 1, "tables": [{
    "name": "records", "primaryKey": ["id"], "sequenceColumn": "id", "parents": [],
    "columns": [
        {"name": "id", "type": "Int", "nullable": False},
        {"name": "text", "type": "String", "nullable": True},
        {"name": "enabled", "type": "Boolean", "nullable": True},
        {"name": "createdAt", "type": "DateTime", "nullable": False},
        {"name": "score", "type": "Float", "nullable": True},
    ],
}]}


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="anythingllm-export-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "snapshot.db"
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("CREATE TABLE records(id INTEGER PRIMARY KEY AUTOINCREMENT,text TEXT,enabled BOOLEAN,createdAt DATETIME NOT NULL,score REAL)")
            db.execute("INSERT INTO records VALUES(1,?,0,1704067200123,0.25)", ('{ "ไทย": "ciphertext:iv" }',))
            db.execute("INSERT INTO records VALUES(500,'deleted',1,1704067200123,NULL)")
            db.execute("DELETE FROM records WHERE id=500")
        self.module = load_module()

    def export(self, contract=CONTRACT):
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        target = self.root / "export.ndjson"
        result = self.module.export_snapshot(self.source, target, contract, digest)
        return result, [json.loads(line) for line in target.read_text().splitlines()]

    def test_preserves_tagged_values_and_deleted_sequence_bound(self):
        result, lines = self.export()
        row = next(line for line in lines if line["kind"] == "row")
        self.assertEqual(row["values"], [
            ["Int", "1"], ["String", '{ "ไทย": "ciphertext:iv" }'],
            ["Boolean", False], ["DateTime", "2024-01-01T00:00:00.123Z"], ["Float", "0.25"],
        ])
        table = next(line for line in lines if line["kind"] == "table")
        self.assertEqual(table["sequence"], "500")
        self.assertEqual(result["counts"], {"records": 1})
        self.assertEqual(lines[-1]["kind"], "complete")
        self.assertEqual((self.root / "export.ndjson").stat().st_mode & 0o777, 0o600)

    def test_null_empty_false_and_zero_are_distinct(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("INSERT INTO records(text,enabled,createdAt,score) VALUES('',NULL,'2024-01-01T00:00:00.000Z',0)")
        _, lines = self.export()
        values = [line["values"] for line in lines if line["kind"] == "row"][1]
        self.assertEqual(values[1:3], [["String", ""], ["null", None]])
        self.assertEqual(float(values[4][1]), 0.0)

    def test_wrong_snapshot_hash_does_not_create_output(self):
        with self.assertRaisesRegex(ValueError, "identity"):
            self.module.export_snapshot(self.source, self.root / "export.ndjson", CONTRACT, "0" * 64)
        self.assertFalse((self.root / "export.ndjson").exists())

    def test_unknown_table_or_column_is_not_skipped(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("CREATE TABLE unexpected(id INTEGER)")
        with self.assertRaisesRegex(ValueError, "schema"):
            self.export()

    def test_invalid_boolean_is_not_coerced(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE records SET enabled=2")
        with self.assertRaisesRegex(ValueError, "Boolean"):
            self.export()

    def test_out_of_range_integer_is_not_truncated(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE records SET id=2147483648")
        with self.assertRaisesRegex(ValueError, "Int"):
            self.export()

    def test_nul_text_is_not_replaced(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE records SET text=?", ("bad\x00text",))
        with self.assertRaisesRegex(ValueError, "String"):
            self.export()

    def test_timestamp_precision_is_not_silently_rounded(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE records SET createdAt='2024-01-01T00:00:00.123456Z'")
        with self.assertRaisesRegex(ValueError, "DateTime"):
            self.export()

    def test_active_wal_snapshot_is_not_treated_as_immutable(self):
        db = sqlite3.connect(self.source)
        self.addCleanup(db.close)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("INSERT INTO records(text,createdAt) VALUES('wal',1704067200123)")
        db.commit()
        with self.assertRaisesRegex(ValueError, "closed"):
            self.export()


if __name__ == "__main__":
    unittest.main()
