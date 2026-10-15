import importlib.util
from pathlib import Path
import sqlite3
from contextlib import closing
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))


class SourceSchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.migrations = Path(__file__).parents[3] / "server/prisma/migrations"
        for migration in sorted(self.migrations.glob("*/migration.sql")):
            self.db.executescript(migration.read_text())

    def verifier(self):
        import source_schema
        return source_schema.verify_source_schema

    def test_all_original_migrations_are_accepted_without_source_changes(self):
        self.verifier()(self.db, self.migrations)
        self.assertEqual(len(self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()), 40)

    def test_unexplained_index_drift_is_rejected(self):
        self.db.execute("DROP INDEX users_username_key")
        with self.assertRaisesRegex(ValueError, "schema"):
            self.verifier()(self.db, self.migrations)

    def test_unknown_column_is_rejected(self):
        self.db.execute("ALTER TABLE users ADD COLUMN unexpected TEXT")
        with self.assertRaisesRegex(ValueError, "schema"):
            self.verifier()(self.db, self.migrations)

    def test_migration_ledger_is_provenance_not_application_schema(self):
        self.db.execute("CREATE TABLE _prisma_migrations(id TEXT PRIMARY KEY,checksum TEXT,migration_name TEXT)")
        self.db.execute("INSERT INTO _prisma_migrations VALUES('fixture','fixture','fixture')")
        self.verifier()(self.db, self.migrations)

    def test_unexpected_view_or_trigger_is_not_ignored(self):
        self.db.execute("CREATE VIEW surprise AS SELECT * FROM users")
        with self.assertRaisesRegex(ValueError, "schema"):
            self.verifier()(self.db, self.migrations)

    def test_default_string_case_changes_are_not_normalized_away(self):
        self.db.execute("PRAGMA writable_schema=ON")
        self.db.execute("UPDATE sqlite_master SET sql=replace(sql,'''default''','''DEFAULT''') WHERE type='table' AND name='users'")
        self.db.execute("PRAGMA writable_schema=OFF")
        with self.assertRaisesRegex(ValueError, "schema"):
            self.verifier()(self.db, self.migrations)

    def test_missing_personal_mcp_table_is_rejected(self):
        self.db.execute("DROP TABLE personal_mcp_contexts")
        with self.assertRaisesRegex(ValueError, "schema"):
            self.verifier()(self.db, self.migrations)


if __name__ == "__main__":
    unittest.main()
