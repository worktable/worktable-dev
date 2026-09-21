#!/usr/bin/env python3
"""Create and verify release TAR headers without build-machine identity."""

import gzip
from pathlib import Path
import sys
import tarfile


def neutral_header(member):
    member.uid = member.gid = 0
    member.uname = member.gname = ""
    member.mtime = 0
    member.mode = 0o755 if member.isdir() or member.mode & 0o111 else 0o644
    member.pax_headers = {}
    return member


def create(source, output):
    # Suppress gzip's source filename and timestamp as well as TAR ownership.
    with Path(output).open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                archive.add(source, arcname=".", filter=neutral_header)


def verify(path):
    with Path(path).open("rb") as raw:
        header = raw.read(10)
    if len(header) != 10 or header[:4] != b"\x1f\x8b\x08\x00" or header[4:8] != b"\x00" * 4:
        raise ValueError("Release gzip contains unexpected metadata or timestamps")
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            if (member.uid, member.gid, member.uname, member.gname, member.mtime) != (0, 0, "", "", 0):
                raise ValueError("Release TAR contains non-neutral ownership or timestamps")
            # Long paths may require PAX; host paths/times/identity do not.
            if set(member.pax_headers) - {"path", "linkpath"}:
                raise ValueError("Release TAR contains unexpected extended metadata")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "create":
        create(args[1], args[2])
        verify(args[2])
    elif len(args) >= 2 and args[0] == "verify":
        for path in args[1:]:
            verify(path)
    else:
        raise SystemExit("Usage: release-archive.py create <directory> <output> | verify <archives...>")
