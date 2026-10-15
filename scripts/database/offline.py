"""Explicit protected-request operations; no environment/production discovery."""
import json
from pathlib import Path
import sys
from snapshot import capture_snapshot, export_snapshot
from storage import capture_storage, restore_storage
from paths import protected_path


def main():
    operation = sys.argv[1]
    request_path = protected_path(sys.argv[2])
    if request_path.stat().st_mode & 0o077:
        raise ValueError("Request must be protected")
    request = json.loads(request_path.read_text())
    if operation == "capture":
        # This is an operator attestation, not automated proof. Production jobs
        # must independently record stopped writers/reconciliation controls.
        if request.get("writersFrozen") is not True or not request.get("freezeEvidence"):
            raise ValueError("Verified writer freeze evidence is required")
        directory = protected_path(request["directory"])
        directory.mkdir(mode=0o700)
        snapshot = capture_snapshot(request["database"], directory / "sqlite.db")
        storage = capture_storage(request["storage"], directory / "storage.tar", request["excludeStoragePaths"])
        result = {"snapshot": snapshot, "storage": storage}
        (directory / "capture.json").write_text(json.dumps(result))
        (directory / "capture.json").chmod(0o600)
    elif operation == "export":
        result = export_snapshot(request["snapshotPath"], request["exportPath"], request["contract"], request["sourceSha256"])
    elif operation == "restore-storage":
        result = restore_storage(request["archivePath"], request["directory"], request["archiveSha256"])
    else:
        raise ValueError("Unsupported offline operation")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Offline migration operation failed; no recovery success claimed.", file=sys.stderr)
        sys.exit(1)
