"""Local, add-only, owner-only transcript archive for installs.

Claude Code deletes session transcripts after about 30 days, so without a copy a
memory's original log is gone a month after it was written. Jeremy's machines keep
theirs on a NAS (archive-transcripts.sh); an install keeps a compressed copy under
~/Engram/archive instead. The hourly extraction job runs this when engram.env sets
ENGRAM_ARCHIVE_DIR (the installer does; `off` disables it).

    archive_local.py --archive DIR [--claude-dir D] [--codex-home D]
    archive_local.py --archive DIR --size        # one status line, writes nothing

Contract:
  - ADD-ONLY. A transcript that disappears from its source stays in the archive.
    A source that grew by appending replaces its copy only after the archived
    bytes are confirmed as a prefix of the new file (sha256 of the old length).
    Any other change keeps the old copy as `<name>.v<mtime>.gz` beside the new one.
  - OWNER-ONLY. umask 077, directories 0700, files 0600.
  - Portable: stdlib only, no macOS or GNU tools, so the Linux port reuses it.
  - Writes index.tsv in the format engram_explain reads
    (runtime/src/lib/engram/provenance.ts): a `# engram.transcript-index.v1
    dest=local:<dir> generated=<UTC>` header, then archive_key, storage_kind,
    stored_bytes, mtime_epoch, logical_path. Every file is written to a temp name
    and renamed, so an interrupted run leaves the previous state readable.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
import sys
from pathlib import Path

from install_config import read_engram_env

MANIFEST = ".manifest.json"
INDEX = "index.tsv"
CHUNK = 1 << 20


def sources(claude_dir: Path, codex_home: Path) -> list[tuple[str, Path]]:
    """Transcript trees, by store name. ChatGPT Work local threads land in Codex's."""
    return [
        ("claude-projects", claude_dir / "projects"),
        ("codex-sessions", codex_home / "sessions"),
        ("codex-archived", codex_home / "archived_sessions"),
    ]


def prefix_sha256(path: Path, length: int) -> str:
    h = hashlib.sha256()
    left = length
    with path.open("rb") as f:
        while left > 0:
            block = f.read(min(CHUNK, left))
            if not block:
                break
            h.update(block)
            left -= len(block)
    return h.hexdigest() if left == 0 else ""


def write_gzip(src: Path, dest: Path, size: int) -> str:
    """Compress the first `size` bytes of src to dest atomically; return their sha256."""
    dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.tmp-{os.getpid()}")
    h = hashlib.sha256()
    left = size
    with src.open("rb") as f, tmp.open("wb") as raw, \
            gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as out:
        while left > 0:
            block = f.read(min(CHUNK, left))
            if not block:
                break
            h.update(block)
            out.write(block)
            left -= len(block)
    os.chmod(tmp, 0o600)
    os.replace(tmp, dest)
    return h.hexdigest()


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_text(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def archive(root: Path, trees: list[tuple[str, Path]], now: dt.datetime | None = None) -> dict:
    os.umask(0o077)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    try:
        manifest = json.loads((root / MANIFEST).read_text())
    except (OSError, ValueError):
        manifest = {}
    added = updated = versioned = 0
    for store, tree in trees:
        if not tree.is_dir():
            continue
        for src in sorted(tree.rglob("*.jsonl")):
            if not src.is_file() or src.is_symlink():
                continue
            logical = f"{store}/{src.relative_to(tree).as_posix()}"
            st = src.stat()
            size, mtime = st.st_size, int(st.st_mtime)
            dest = root / f"{logical}.gz"
            prev = manifest.get(logical)
            if prev and prev["size"] == size and prev["mtime"] == mtime and dest.exists():
                continue
            if prev and dest.exists():
                appended = size >= prev["size"] and prefix_sha256(src, prev["size"]) == prev["sha256"]
                if not appended:
                    # Rewritten or truncated at the source: keep what was archived.
                    os.replace(dest, dest.with_name(f"{src.name}.v{prev['mtime']}.gz"))
                    versioned += 1
                else:
                    updated += 1
            else:
                added += 1
            digest = write_gzip(src, dest, size)
            manifest[logical] = {"size": size, "mtime": mtime, "sha256": digest}
    write_atomic(root / MANIFEST, json.dumps(manifest, indent=0, sort_keys=True) + "\n")
    stamp = (now or dt.datetime.now(dt.timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = [f"# engram.transcript-index.v1 dest=local:{root} generated={stamp}",
            "archive_key\tstorage_kind\tstored_bytes\tmtime_epoch\tlogical_path"]
    for logical, entry in sorted(manifest.items()):
        gz = root / f"{logical}.gz"
        if not gz.exists():
            continue
        key = Path(logical).name.removesuffix(".jsonl")
        rows.append(f"{key}\tgzip\t{gz.stat().st_size}\t{entry['mtime']}\t{logical}")
    write_atomic(root / INDEX, "\n".join(rows) + "\n")
    return {"added": added, "updated": updated, "versioned": versioned, "sessions": len(rows) - 2}


def size_line(root: Path) -> str:
    if not root.is_dir():
        return f"Transcript archive: none yet at {root}"
    total = files = 0
    for p in root.rglob("*.gz"):
        total += p.stat().st_size
        files += 1
    try:
        stamp = (root / INDEX).read_text().split("\n", 1)[0].rsplit("generated=", 1)[1]
    except (OSError, IndexError):
        stamp = "never"
    return f"Transcript archive: {root} {files} files, {total / 1048576:.1f} MB, last run {stamp}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--archive", required=True, type=Path)
    ap.add_argument("--claude-dir", type=Path)
    ap.add_argument("--codex-home", type=Path)
    ap.add_argument("--size", action="store_true")
    a = ap.parse_args(argv)
    if a.size:
        print(size_line(a.archive))
        return 0
    conf = read_engram_env()
    claude_dir = a.claude_dir or Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    codex_home = a.codex_home or Path(os.environ.get("CODEX_HOME") or conf.get("CODEX_HOME") or Path.home() / ".codex")
    result = archive(a.archive, sources(claude_dir, codex_home))
    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{stamp}] transcript archive: {result['sessions']} sessions "
          f"(+{result['added']} new, {result['updated']} grown, {result['versioned']} kept as versions) in {a.archive}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
