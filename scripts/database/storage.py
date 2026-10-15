"""Protected storage archive primitives. Caller must verify writer freeze.

Does not export Kubernetes Secrets or establish application-key recoverability.
"""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile
from paths import protected_path


INDEX = "__anythingllm_recovery_manifest__.json"


def safe_link(name, target, names):
    if not target or PurePosixPath(target).is_absolute() or "\\" in target:
        raise ValueError("Unsafe storage link")
    parts = list(PurePosixPath(name).parent.parts)
    for part in PurePosixPath(target).parts:
        if part == "..":
            if not parts:
                raise ValueError("Storage link escapes recovery root")
            parts.pop()
        elif part != ".":
            parts.append(part)
    resolved = "/".join(parts)
    if resolved not in names or resolved == name:
        raise ValueError("Storage link target is missing/excluded or cyclic")
    return resolved


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def safe_name(name):
    parts = PurePosixPath(name)
    if not name or parts.is_absolute() or any(part in (".", "..") for part in parts.parts) or "\\" in name:
        raise ValueError("Unsafe archive entry")
    return name


def inventory(root, exclusions):
    entries = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if any(relative == excluded or relative.startswith(excluded + "/") for excluded in exclusions):
            continue
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            resolved = (path.parent / target).resolve()
            if Path(target).is_absolute() or not resolved.is_relative_to(root.resolve()) or not resolved.exists():
                raise ValueError("Unsafe storage symlink")
            entry = {"name": safe_name(relative), "directory": False, "symlink": target, "mode": 0o777, "uid": info.st_uid, "gid": info.st_gid}
            entries.append(entry)
            continue
        if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode):
            raise ValueError("Unsupported storage device entry")
        directory = stat.S_ISDIR(info.st_mode)
        if relative == INDEX or info.st_mode & (0o5000 if directory else 0o7000):
            raise ValueError("Unsupported storage name or permissions")
        entry = {"name": safe_name(relative), "directory": directory, "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}
        if path.is_file():
            entry.update({"size": info.st_size, "sha256": digest(path)})
        entries.append(entry)
    names = {entry["name"] for entry in entries}
    by_name = {entry["name"]: entry for entry in entries}
    for entry in entries:
        if "symlink" in entry:
            resolved = safe_link(entry["name"], entry["symlink"], names)
            if "symlink" in by_name[resolved]:
                raise ValueError("Chained storage links need explicit review")
    return entries


def capture_storage(source, destination, exclusions):
    source = protected_path(source)
    destination = protected_path(destination)
    if source.is_symlink() or not source.is_dir() or destination.is_symlink() or destination.resolve().is_relative_to(source.resolve()):
        raise ValueError("Invalid storage capture paths")
    exclusions = [safe_name(name) for name in exclusions]
    entries = inventory(source, exclusions)
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream, tarfile.open(fileobj=stream, mode="w") as archive:
        for entry in entries:
            archive.add(source / entry["name"], arcname=entry["name"], recursive=False)
        if inventory(source, exclusions) != entries:
            raise ValueError("Storage changed during capture; no complete recovery set")
        payload = json.dumps({"version": 1, "entries": entries}, separators=(",", ":")).encode()
        manifest = tarfile.TarInfo(INDEX)
        manifest.size = len(payload)
        manifest.mode = 0o600
        archive.addfile(manifest, io.BytesIO(payload))
    return {"sha256": digest(destination), "entries": len(entries)}


def restore_storage(source, destination, expected_sha256):
    source = protected_path(source)
    destination = protected_path(destination)
    if source.is_symlink() or not source.is_file() or digest(source) != expected_sha256:
        raise ValueError("Storage archive identity mismatch")
    if destination.exists() or destination.is_symlink():
        raise FileExistsError("Restore destination must be fresh")
    with tarfile.open(source, "r:") as archive:
        members = archive.getmembers()
        names = [safe_name(member.name) for member in members]
        if len(set(names)) != len(names) or names.count(INDEX) != 1:
            raise ValueError("Storage archive manifest or duplicate entry mismatch")
        if any(not member.isfile() and not member.isdir() and not member.issym() or member.mode & (0o5000 if member.isdir() else 0o7000) for member in members):
            raise ValueError("Unsafe storage archive type or permissions")
        manifest_member = archive.getmember(INDEX)
        if not manifest_member.isfile() or manifest_member.size > 16 * 1024 * 1024:
            raise ValueError("Invalid storage manifest")
        with archive.extractfile(manifest_member) as stream:
            manifest = json.load(stream)
        if manifest.get("version") != 1 or not isinstance(manifest.get("entries"), list):
            raise ValueError("Invalid storage manifest")
        entries = manifest["entries"]
        if {entry["name"] for entry in entries} != set(names) - {INDEX}:
            raise ValueError("Storage inventory mismatch")
        for entry in entries:
            safe_name(entry["name"])
            member = archive.getmember(entry["name"])
            if member.issym():
                if member.linkname != entry.get("symlink"):
                    raise ValueError("Storage link metadata mismatch")
                resolved = safe_link(entry["name"], member.linkname, set(names) - {INDEX})
                if archive.getmember(resolved).issym():
                    raise ValueError("Chained storage link is rejected")
                # No archive entry may write through the restored link.
                if any(name.startswith(entry["name"] + "/") for name in names):
                    raise ValueError("Storage entry traverses a link")
                continue
            if member.isdir() != entry["directory"] or member.mode != entry["mode"]:
                raise ValueError("Storage metadata mismatch")
            if member.isfile():
                with archive.extractfile(member) as stream:
                    if member.size != entry["size"] or hashlib.file_digest(stream, "sha256").hexdigest() != entry["sha256"]:
                        raise ValueError("Storage payload checksum mismatch")
        destination.mkdir(mode=0o700)
        for entry in entries:
            member = archive.getmember(entry["name"])
            target = destination / entry["name"]
            if member.issym():
                continue
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, "wb") as output, archive.extractfile(member) as stream:
                    while chunk := stream.read(1024 * 1024):
                        output.write(chunk)
        for entry in sorted(entries, key=lambda entry: len(PurePosixPath(entry["name"]).parts), reverse=True):
            if "symlink" not in entry:
                os.chmod(destination / entry["name"], entry["mode"])
        # Links are created last and never followed during extraction.
        for entry in entries:
            if "symlink" in entry:
                target = destination / entry["name"]
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                target.symlink_to(entry["symlink"])
    return {"entries": len(entries), "sha256": expected_sha256}
