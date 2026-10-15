from pathlib import Path
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
import sys
sys.path.insert(0, str(Path(__file__).parents[1]))


def load_module():
    spec = importlib.util.spec_from_file_location("migration_storage", Path(__file__).parents[1] / "storage.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="anythingllm-storage-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.storage = self.root / "storage"
        self.storage.mkdir()
        (self.storage / "documents").mkdir()
        (self.storage / "empty").mkdir()
        (self.storage / ".env").write_text("fixture-config-never-log")
        (self.storage / ".env").chmod(0o600)
        (self.storage / "documents" / "ไทย.txt").write_text("fixture Thai ไทย")
        (self.storage / "anythingllm.db").write_bytes(b"live-database-excluded")
        self.module = load_module()

    def test_capture_restore_preserves_files_and_modes_but_excludes_live_db(self):
        archive = self.root / "storage.tar"
        result = self.module.capture_storage(self.storage, archive, ["anythingllm.db"])
        restored = self.root / "restored"
        self.module.restore_storage(archive, restored, result["sha256"])
        self.assertEqual((restored / "documents" / "ไทย.txt").read_text(), "fixture Thai ไทย")
        self.assertEqual((restored / ".env").read_text(), "fixture-config-never-log")
        self.assertEqual((restored / ".env").stat().st_mode & 0o777, 0o600)
        self.assertTrue((restored / "empty").is_dir())
        self.assertFalse((restored / "anythingllm.db").exists())
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)

    def test_refuses_recursive_destination_inside_source(self):
        with self.assertRaises(ValueError):
            self.module.capture_storage(self.storage, self.storage / "backup.tar", [])

    def test_preserves_pvc_setgid_directories(self):
        directory = self.storage / "documents"
        directory.chmod(0o2770)
        if directory.stat().st_mode & 0o7777 != 0o2770:
            self.skipTest("Filesystem cannot retain setgid; Linux maintenance smoke is required")
        archive = self.root / "storage.tar"
        result = self.module.capture_storage(self.storage, archive, ["anythingllm.db"])
        restored = self.root / "restored"
        self.module.restore_storage(archive, restored, result["sha256"])
        self.assertEqual((restored / "documents").stat().st_mode & 0o7777, 0o2770)
        self.assertEqual((restored / "documents" / "ไทย.txt").read_text(), "fixture Thai ไทย")

    def permission_archive(self, directory_mode=0o770, file_mode=0o600):
        archive = self.root / "permissions.tar"
        payload = b"synthetic preserved storage"
        entries = [
            {"name": "documents", "directory": True, "mode": directory_mode, "uid": 1000, "gid": 1000},
            {"name": "documents/preserved.txt", "directory": False, "mode": file_mode,
             "uid": 1000, "gid": 1000, "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()},
        ]
        with tarfile.open(archive, "w") as stream:
            directory = tarfile.TarInfo("documents")
            directory.type = tarfile.DIRTYPE
            directory.mode = directory_mode
            stream.addfile(directory)
            member = tarfile.TarInfo("documents/preserved.txt")
            member.mode = file_mode
            member.size = len(payload)
            stream.addfile(member, io.BytesIO(payload))
            manifest = json.dumps({"version": 1, "entries": entries}).encode()
            index = tarfile.TarInfo("__anythingllm_recovery_manifest__.json")
            index.mode = 0o600
            index.size = len(manifest)
            stream.addfile(index, io.BytesIO(manifest))
        return archive, hashlib.sha256(archive.read_bytes()).hexdigest()

    def test_restores_valid_setgid_directory_archive(self):
        archive, checksum = self.permission_archive(directory_mode=0o2770)
        restored = self.root / "restored"
        result = self.module.restore_storage(archive, restored, checksum)
        self.assertEqual(result["entries"], 2)
        self.assertEqual((restored / "documents/preserved.txt").read_bytes(), b"synthetic preserved storage")
        self.assertEqual((restored / "documents").stat().st_mode & 0o777, 0o770)

    def test_rejects_disallowed_special_modes_before_restoring(self):
        for directory_mode, file_mode in [
            (0o4770, 0o600),
            (0o1770, 0o600),
            (0o6770, 0o600),
            (0o3770, 0o600),
            (0o770, 0o2600),
            (0o770, 0o4600),
            (0o770, 0o1600),
            (0o770, 0o7600),
        ]:
            with self.subTest(directory_mode=oct(directory_mode), file_mode=oct(file_mode)):
                archive, checksum = self.permission_archive(directory_mode, file_mode)
                restored = self.root / "restored"
                with self.assertRaisesRegex(ValueError, "Unsafe storage archive type or permissions"):
                    self.module.restore_storage(archive, restored, checksum)
                self.assertFalse(restored.exists())

    def test_rejects_disallowed_special_modes_during_capture(self):
        for relative, mode in [
            ("documents", 0o4770),
            ("documents", 0o1770),
            ("documents", 0o6770),
            ("documents/ไทย.txt", 0o2600),
            ("documents/ไทย.txt", 0o4600),
            ("documents/ไทย.txt", 0o1600),
        ]:
            with self.subTest(relative=relative, mode=oct(mode)):
                target = self.storage / relative
                original_mode = target.stat().st_mode & 0o7777
                try:
                    target.chmod(mode)
                    if target.stat().st_mode & 0o7777 != mode:
                        self.skipTest("Filesystem cannot retain this special mode; Linux checks are required")
                    archive = self.root / "rejected.tar"
                    with self.assertRaisesRegex(ValueError, "Unsupported storage name or permissions"):
                        self.module.capture_storage(self.storage, archive, ["anythingllm.db"])
                    self.assertFalse(archive.exists())
                finally:
                    target.chmod(original_mode)

    def test_refuses_symlink_in_storage(self):
        (self.storage / "escape").symlink_to(self.root)
        with self.assertRaises(ValueError):
            self.module.capture_storage(self.storage, self.root / "backup.tar", [])

    def test_refuses_existing_restore_and_archive_destinations(self):
        archive = self.root / "storage.tar"
        result = self.module.capture_storage(self.storage, archive, ["anythingllm.db"])
        with self.assertRaises(FileExistsError):
            self.module.capture_storage(self.storage, archive, [])
        with self.assertRaises(FileExistsError):
            self.module.restore_storage(archive, self.storage, result["sha256"])

    def test_rejects_wrong_archive_checksum(self):
        archive = self.root / "storage.tar"
        self.module.capture_storage(self.storage, archive, [])
        with self.assertRaises(ValueError):
            self.module.restore_storage(archive, self.root / "restored", "0" * 64)
        self.assertFalse((self.root / "restored").exists())

    def test_rejects_archive_traversal_before_creating_recovery(self):
        archive = self.root / "unsafe.tar"
        with tarfile.open(archive, "w") as tar:
            info = tarfile.TarInfo("../outside")
            info.size = 4
            tar.addfile(info, io.BytesIO(b"evil"))
        import hashlib
        with self.assertRaises(ValueError):
            self.module.restore_storage(archive, self.root / "restored", hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertFalse((self.root / "outside").exists())
        self.assertFalse((self.root / "restored").exists())

    def test_preserves_zero_byte_files(self):
        (self.storage / "documents" / "empty.txt").touch()
        archive = self.root / "storage.tar"
        result = self.module.capture_storage(self.storage, archive, ["anythingllm.db"])
        self.module.restore_storage(archive, self.root / "restored", result["sha256"])
        self.assertEqual((self.root / "restored" / "documents" / "empty.txt").read_bytes(), b"")

    def test_refuses_symlink_restore_parent(self):
        archive = self.root / "storage.tar"
        result = self.module.capture_storage(self.storage, archive, ["anythingllm.db"])
        parent = self.root / "linked"
        parent.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.module.restore_storage(archive, parent / "restored", result["sha256"])

    def test_preserves_internal_relative_cache_links_without_following_them(self):
        cache = self.storage / ".npm-bridge"
        (cache / "bin").mkdir(parents=True)
        (cache / "package").mkdir()
        (cache / "package" / "entry.js").write_text("synthetic-cache-entry")
        (cache / "bin" / "tool").symlink_to("../package/entry.js")
        archive = self.root / "storage.tar"
        result = self.module.capture_storage(self.storage, archive, ["anythingllm.db"])
        restored = self.root / "restored"
        self.module.restore_storage(archive, restored, result["sha256"])
        link = restored / ".npm-bridge/bin/tool"
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.readlink().as_posix(), "../package/entry.js")
        self.assertEqual(link.read_text(), "synthetic-cache-entry")

    def test_rejects_internal_link_whose_target_is_excluded(self):
        (self.storage / "database-alias").symlink_to("anythingllm.db")
        with self.assertRaises(ValueError):
            self.module.capture_storage(self.storage, self.root / "storage.tar", ["anythingllm.db"])

    def test_rejects_absolute_links_even_when_they_point_inside(self):
        (self.storage / "absolute").symlink_to(self.storage / "documents/ไทย.txt")
        with self.assertRaises(ValueError):
            self.module.capture_storage(self.storage, self.root / "storage.tar", [])


if __name__ == "__main__":
    unittest.main()
