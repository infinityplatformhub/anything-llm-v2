"""Compare immutable source catalogs with original migration history in memory."""
import sqlite3
from contextlib import closing
from pathlib import Path
import re


def catalog(db):
    # Compare logical SQL, not rowids, page layout or SQLite's rewritten quoting.
    def normalized(sql):
        parts = re.split(r"('(?:[^']|'')*')", sql or "")
        # Keywords/identifier formatting can differ after SQLite table rename;
        # string defaults cannot be case-folded or whitespace-normalized.
        return ''.join(part if index % 2 else re.sub(r"\s+", " ", part.replace('"', '')).lower() for index, part in enumerate(parts)).strip()
    return sorted(
        (kind, name, table, normalized(sql))
        for kind, name, table, sql in db.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' AND tbl_name != '_prisma_migrations'"
        )
    )


def verify_source_schema(source, migrations):
    root = Path(migrations)
    migrations = sorted(root.glob("*/migration.sql"))
    if not migrations:
        raise ValueError("Source schema migration history is unavailable")
    with closing(sqlite3.connect(":memory:")) as expected:
        for migration in migrations:
            expected.executescript(migration.read_text())
        if catalog(source) != catalog(expected):
            raise ValueError("Source schema differs from reviewed migration history")
