#!/opt/homebrew/bin/python3.12
"""mirror_memory.py: project memory files -> <vault>/Memory/ projection, for installs.

A port of the user-path part of the operator's own mirror script, which lives outside
this repo and keeps running under its own launchd job. Memories
the extractor writes under ENGRAM_MEMORY_ROOT/<encoded project>/memory/*.md are
copied into KG_VAULT_PATH/Memory/<slug>/ so the index picks them up. Both come
from ~/.config/engram/engram.env, with Jeremy's layout as the default.

Carried over unchanged: the slug scheme, the frontmatter enrichment (created, the
memory tag, source_path, mirrored_from, mirrored_by), the mtime skip, the atomic
tmp-then-move write, prune only of files this machine mirrored (mirrored_by) inside
slugs it produces, never pruning legacy files without an owner, and report-only
orphan detection. Not carried over: Hermes and OpenClaw sources and BRIEF.md
mirroring, which only Jeremy's machines have. `created` uses the machine's local
time zone where the original pins America/Los_Angeles.

The two copies can drift; extraction/test_mirror_memory.py diffs them on a fixture
(STUBS.md).

    mirror_memory.py [--dry-run]
"""
from __future__ import annotations

import shutil
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

import frontmatter  # python-frontmatter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from install_config import read_engram_env  # noqa: E402


def settings(home: Path | None = None) -> tuple[Path, Path, str]:
    home = home or Path.home()
    conf = read_engram_env(home)
    projects = Path(conf.get("ENGRAM_MEMORY_ROOT", home / ".claude" / "projects"))
    vault = Path(conf.get("KG_VAULT_PATH", home / "claude-vault" / "vault"))
    machine_file = home / ".machine"
    machine = (machine_file.read_text().strip() if machine_file.exists() else "") or socket.gethostname().split(".")[0]
    return projects, vault / "Memory", machine


def slug_for(project_dir_name: str) -> str:
    tail = project_dir_name.rstrip("-").split("-")[-1] or "root"
    return f"{tail}__{project_dir_name.strip('-')[:60]}"


def iso_created(p: Path) -> str:
    return datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).astimezone().isoformat()


def mirror_one(src: Path, dst: Path, origin: str, machine: str, dry_run: bool) -> str:  # branch-divergence: intentional — an unchanged source is skipped before anything is written
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return "skipped"
    try:
        post = frontmatter.load(src)
    except Exception as e:  # branch-divergence: intentional — an unparseable note is skipped, as in the original
        print(f"skip (parse): {src} — {e}", file=sys.stderr)
        return "skipped"
    post.metadata.setdefault("created", iso_created(src))
    tags = post.metadata.get("tags", [])
    if isinstance(tags, str):
        tags = [tags]
    if "memory" not in tags:
        tags.append("memory")
    post.metadata["tags"] = tags
    post.metadata["source_path"] = str(src)
    post.metadata["mirrored_from"] = origin
    post.metadata["mirrored_by"] = machine
    if dry_run:
        return "mirrored"
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".md.tmp")
    tmp.write_text(frontmatter.dumps(post))
    shutil.move(str(tmp), str(dst))
    return "mirrored"


def _is_generated(meta: dict) -> bool:
    if meta.get("managed") is True:
        return True
    t = str(meta.get("type") or "")
    return t == "agent_profile" or t.startswith("engram_")


def _all_generated(d: Path) -> bool:
    notes = list(d.rglob("*.md"))
    if not notes:
        return False
    for f in notes:
        try:
            if not _is_generated(frontmatter.load(f).metadata):
                return False
        except Exception:  # branch-divergence: intentional — unreadable means not provably generated
            return False
    return True


def run(home: Path | None = None, dry_run: bool = False) -> dict:  # branch-divergence: intentional — no source dir means nothing to mirror or prune
    projects, vault_memory, machine = settings(home)
    if not projects.is_dir():
        print(f"no memory source at {projects}", file=sys.stderr)
        return {"error": "no-source"}
    if not dry_run:
        vault_memory.mkdir(parents=True, exist_ok=True)
    counts = {"mirrored": 0, "skipped": 0, "pruned": 0}
    current, owned = set(), set()
    for proj in sorted(projects.iterdir()):
        mem = proj / "memory"
        if not mem.is_dir():
            continue
        slug = slug_for(proj.name)
        owned.add(slug)
        for src in mem.glob("*.md"):
            dst = vault_memory / slug / src.name
            current.add(dst)
            counts[mirror_one(src, dst, proj.name, machine, dry_run)] += 1

    # Prune only copies this machine mirrored, inside slugs it produces. Legacy files
    # without mirrored_by are never pruned.
    if vault_memory.is_dir():
        for dst in vault_memory.rglob("*.md"):
            if dst.parent.name not in owned or dst in current:
                continue
            try:
                owner = frontmatter.load(dst).metadata.get("mirrored_by")
            except Exception:  # branch-divergence: intentional — unreadable owner is never pruned
                owner = None
            if owner != machine:
                continue
            if not dry_run:
                dst.unlink()
            counts["pruned"] += 1

    # Report, never delete, directories no slug scheme produces.
    orphans = []
    if vault_memory.is_dir():
        for d in sorted(x for x in vault_memory.iterdir() if x.is_dir()):
            if "__" in d.name or _all_generated(d):
                continue
            orphans.append((d.name, len(list(d.rglob("*.md")))))
    tag = "[dry-run] " if dry_run else ""
    print(f"{tag}mirrored={counts['mirrored']} skipped={counts['skipped']} pruned={counts['pruned']} → {vault_memory}")
    for name, n in orphans:
        print(f"{tag}WARNING: orphaned slug dir {name}/ ({n} notes) has no producer", file=sys.stderr)
    return {**counts, "orphans": [o[0] for o in orphans]}


def main() -> int:
    result = run(dry_run="--dry-run" in sys.argv)
    return 1 if result.get("error") else 0


if __name__ == "__main__":
    sys.exit(main())
