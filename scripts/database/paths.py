"""Reject link components, allowing macOS's fixed system temporary aliases."""
from pathlib import Path


def protected_path(value):
    path = Path(value).absolute()
    for alias in (Path("/var"), Path("/tmp")):
        canonical = Path("/private") / alias.name
        if alias.is_symlink() and alias.resolve() == canonical and path.is_relative_to(alias):
            path = canonical / path.relative_to(alias)
    for component in (path, *path.parents):
        if component.is_symlink():
            raise ValueError("Protected paths must not contain symlink components")
    return path
