import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile


CLI = "/app/maintenance/scripts/database/cli.cjs"
ENVIRONMENT = {
    "PATH": os.environ["PATH"],
    "HOME": "/tmp",
    "PYTHONDONTWRITEBYTECODE": "1",
}


def run_command(arguments):
    return subprocess.run(
        arguments,
        env=ENVIRONMENT,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    ).stdout


def main():
    if os.getuid() != 1000:
        raise AssertionError("Fixture must use the default non-root runtime user")
    maintenance_root = Path("/app/maintenance")
    allowed_suffixes = {".cjs", ".py", ".prisma", ".sql", ".toml"}
    for packaged_file in maintenance_root.rglob("*"):
        if packaged_file.is_file() and packaged_file.suffix not in allowed_suffixes:
            raise AssertionError("Maintenance source contains a non-allowlisted file")
    run_command([
        "node",
        "-e",
        'require("node:assert/strict").deepEqual('
        'require("/app/maintenance/scripts/database/provider-artifact.cjs").createArtifact("postgresql"),'
        'require("/app/scripts/database/provider-artifact.cjs").createArtifact("postgresql"));',
    ])
    with tempfile.TemporaryDirectory(prefix="anythingllm-maintenance-fixture-") as temporary:
        root = Path(temporary)

        def call_cli(operation, request, expected_success=True):
            request_path = root / f"request-{operation}-{len(list(root.glob('request-*')))}.json"
            request_path.write_text(json.dumps(request))
            request_path.chmod(0o600)
            result = subprocess.run(
                ["node", CLI, operation, "--request", str(request_path)],
                env=ENVIRONMENT,
                capture_output=True,
                text=True,
                timeout=60,
            )
            if expected_success:
                if result.returncode != 0:
                    raise AssertionError(f"Synthetic {operation} failed: {result.stderr}")
                return json.loads(result.stdout)
            if result.returncode == 0:
                raise AssertionError(f"Synthetic {operation} unexpectedly succeeded")

        contract = json.loads(run_command(["node", CLI, "contract"]))
        source = root / "source.sqlite"
        migrations_root = Path("/app/maintenance/server/prisma/migrations")
        migrations = sorted(migrations_root.glob("*/migration.sql"))
        if not migrations:
            raise AssertionError("Reviewed source migration history is missing")
        with sqlite3.connect(source) as connection:
            for migration in migrations:
                connection.executescript(migration.read_text())
            connection.execute(
                "INSERT INTO api_keys (name, secret) VALUES (?, ?)",
                ("synthetic-maintenance", "fixture-not-a-production-secret"),
            )
        source.chmod(0o600)
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        storage = root / "storage"
        storage.mkdir(mode=0o700)
        documents = storage / "documents"
        documents.mkdir(mode=0o700)
        documents.chmod(0o2770)
        if documents.stat().st_mode & 0o7777 != 0o2770:
            raise AssertionError("Linux fixture must retain PVC setgid directory permissions")
        payload = documents / "synthetic.txt"
        payload.write_bytes(b"synthetic maintenance storage\n")
        payload.chmod(0o600)
        freeze_evidence = root / "freeze.json"
        freeze_evidence.write_text(json.dumps({"synthetic": True, "sourceClosed": True}))
        freeze_evidence.chmod(0o600)
        capture_directory = root / "capture"
        capture_request = {
            "database": str(source),
            "storage": str(storage),
            "directory": str(capture_directory),
            "excludeStoragePaths": [],
            "writersFrozen": True,
            "freezeEvidence": str(freeze_evidence),
        }
        call_cli("capture", {**capture_request, "writersFrozen": False}, False)
        if capture_directory.exists():
            raise AssertionError("Rejected capture created an output directory")
        capture = call_cli("capture", capture_request)
        for relative, mode in [
            ("documents", 0o4770),
            ("documents", 0o1770),
            ("documents", 0o6770),
            ("documents/synthetic.txt", 0o2600),
            ("documents/synthetic.txt", 0o4600),
            ("documents/synthetic.txt", 0o1600),
        ]:
            target = storage / relative
            original_mode = target.stat().st_mode & 0o7777
            rejected_capture = root / f"rejected-{mode:o}"
            try:
                target.chmod(mode)
                if target.stat().st_mode & 0o7777 != mode:
                    raise AssertionError("Linux fixture must retain disallowed permission bits")
                call_cli("capture", {**capture_request, "directory": str(rejected_capture)}, False)
                if (rejected_capture / "storage.tar").exists() or (rejected_capture / "capture.json").exists():
                    raise AssertionError("Disallowed permissions produced a storage recovery set")
            finally:
                target.chmod(original_mode)
        snapshot = capture_directory / "sqlite.db"
        export = root / "export.jsonl"
        export_request = {
            "snapshotPath": str(snapshot),
            "sourceSha256": capture["snapshot"]["sha256"],
            "contract": contract,
            "exportPath": str(export),
        }
        call_cli("export", export_request)
        if "synthetic-maintenance" not in export.read_text():
            raise AssertionError("Fixture row was not exported")
        rejected_export = root / "wrong-hash.jsonl"
        call_cli("export", {
            **export_request,
            "sourceSha256": "0" * 64,
            "exportPath": str(rejected_export),
        }, False)
        if rejected_export.exists():
            raise AssertionError("Wrong-checksum export created output")
        restored_directory = root / "restored"
        call_cli("restore-storage", {
            "archivePath": str(capture_directory / "storage.tar"),
            "archiveSha256": capture["storage"]["sha256"],
            "directory": str(restored_directory),
        })
        if (restored_directory / "documents" / payload.name).read_bytes() != payload.read_bytes():
            raise AssertionError("Recovered fixture storage does not match")
        if (restored_directory / "documents").stat().st_mode & 0o7777 != 0o2770:
            raise AssertionError("Recovered PVC setgid directory permissions do not match")
        if documents.stat().st_mode & 0o7777 != 0o2770:
            raise AssertionError("Original PVC setgid directory permissions changed")
        if hashlib.sha256(source.read_bytes()).hexdigest() != source_hash:
            raise AssertionError("Original fixture database changed")
        for protected_file in [snapshot, export, capture_directory / "capture.json"]:
            if protected_file.stat().st_mode & 0o077:
                raise AssertionError("Fixture output is not protected")
        print(json.dumps({
            "passed": True,
            "syntheticOnly": True,
            "uid": os.getuid(),
            "models": len(contract["tables"]),
            "checks": [
                "context-allowlist",
                "runtime-schema-provenance",
                "contract",
                "freeze-required",
                "snapshot",
                "typed-export",
                "checksum-rejection",
                "storage-restore",
                "pvc-setgid-preserved",
                "disallowed-permissions-rejected",
                "source-preserved",
                "protected-output",
            ],
        }))


if __name__ == "__main__":
    main()
