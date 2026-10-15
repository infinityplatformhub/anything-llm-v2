"""Independent read-only source for preservation checks; no export decoding."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
from contextlib import closing
from paths import protected_path


def emit(value):
    print(json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False))


def main():
    request = json.load(sys.stdin)
    snapshot = protected_path(request["snapshot"])
    with snapshot.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != request["sha256"]:
            raise ValueError("Original snapshot identity mismatch")
    if any(Path(str(snapshot) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise ValueError("Original snapshot is not closed")
    def quote(value):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
            raise ValueError("Invalid field identity")
        return '"' + value + '"'
    with closing(sqlite3.connect(snapshot.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        has_sequence = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").fetchone() is not None
        for table in request["contract"]["tables"]:
            fields = table["columns"]
            select = ",".join(quote(field["name"]) for field in fields)
            order = ",".join(quote(field) for field in table["primaryKey"])
            if table["sequenceColumn"]:
                maximum = db.execute("SELECT max(" + quote(table["sequenceColumn"]) + ") FROM " + quote(table["name"])).fetchone()[0]
                sequences = db.execute("SELECT seq FROM sqlite_sequence WHERE name=?", (table["name"],)).fetchmany(2) if has_sequence else []
                if len(sequences) > 1:
                    raise ValueError("Ambiguous source sequence")
                sequence = sequences[0][0] if sequences else None
                if maximum is not None and (type(maximum) is not int or not -2147483648 <= maximum <= 2147483647):
                    raise ValueError("Invalid source sequence maximum")
                if sequences and (type(sequence) is not int or not 0 <= sequence <= 2147483647):
                    raise ValueError("Invalid source sequence high-water mark")
                if max(0, maximum or 0, sequence or 0) >= 2147483647:
                    raise ValueError("Source sequence next ID exceeds Int capacity")
                emit({"kind": "sequence", "table": table["name"], "maximum": str(maximum) if maximum is not None else None, "sequence": str(sequence) if sequence is not None else None})
            count = 0
            for row in db.execute("SELECT " + select + " FROM " + quote(table["name"]) + " ORDER BY " + order):
                values = []
                for field, value in zip(fields, row):
                    kind = field["type"]
                    if value is not None and kind == "DateTime":
                        if type(value) is int:
                            value = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(milliseconds=value)
                        else:
                            value = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
                            if value.tzinfo is None:
                                value = value.replace(tzinfo=datetime.timezone.utc)
                        if value.microsecond % 1000:
                            raise ValueError("Unsupported source precision")
                        value = value.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                    elif value is not None and kind == "Boolean":
                        if type(value) is not int or value not in (0, 1):
                            raise ValueError("Invalid source boolean")
                        value = bool(value)
                    elif value is not None and kind == "Int":
                        value = str(value)
                    values.append(value)
                emit({"kind": "row", "table": table["name"], "values": values})
                count += 1
            emit({"kind": "count", "table": table["name"], "count": count})
    with snapshot.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != request["sha256"]:
            raise ValueError("Original snapshot changed during verification")
    emit({"kind": "complete"})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Independent snapshot verification failed.", file=sys.stderr)
        sys.exit(1)
