#!/opt/homebrew/bin/python3.12
"""mirror_memory.py: project memory files -> <vault>/Memory/ projection, for installs.

A tracked port of the operator's mirror script. Memories
the extractor writes under ENGRAM_MEMORY_ROOT/<encoded project>/memory/*.md are
copied into KG_VAULT_PATH/Memory/<slug>/ so the index picks them up. Both come
from ~/.config/engram/engram.env, with Jeremy's layout as the default.

Carried over unchanged: the slug scheme, the frontmatter enrichment (created, the
memory tag, source_path, mirrored_from, mirrored_by), the mtime skip, the atomic
tmp-then-move write, prune only of files this machine mirrored (mirrored_by) inside
slugs it produces, never pruning legacy files without an owner, and report-only
orphan detection. `--operator` also projects the existing Hermes and OpenClaw
sources and BRIEF.md files. `created` uses the machine's local
time zone where the original pins America/Los_Angeles.

The two copies can drift; extraction/test_mirror_memory.py diffs them on a fixture
(STUBS.md).

    mirror_memory.py [--operator] [--dry-run]
"""
from __future__ import annotations

import os
from contextlib import ExitStack
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

import frontmatter  # python-frontmatter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from install_config import read_engram_env  # noqa: E402
from capture_policy import (CapturePolicyBlocked, capture_artifact_allowed, capture_path_allowed, capture_scope,
    current_capture_sources, include_capture_paths, read_capture_policy, require_capture_allowed)
from capture_binding import bound_document_capture


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


def mirror_one(src: Path, dst: Path, origin: str, machine: str, dry_run: bool, post=None, brief=False) -> str:
    policy = read_capture_policy()
    if not capture_path_allowed(policy, src) or not capture_path_allowed(policy, dst):
        return "skipped"
    try:
        post = post or frontmatter.load(src)
    except Exception as e:
        if policy['state'] == 'legacy':
            print(f"skip (parse): {src}: {e}", file=sys.stderr)
        return "skipped"
    if not brief and not capture_artifact_allowed(policy, post.metadata):
        return "skipped"
    if dst.exists():
        try:
            previous = frontmatter.load(dst).metadata
            old_path = previous.get('source_path')
            if old_path and Path(old_path).resolve() != src.resolve():
                raise CapturePolicyBlocked('routing_conflict')
            if not old_path and policy['state'] != 'legacy':
                raise CapturePolicyBlocked('routing_unverified')
        except CapturePolicyBlocked:
            raise
        except Exception:
            if policy['state'] != 'legacy':
                raise CapturePolicyBlocked('routing_unverified') from None
    with ExitStack() as stack:
        sources = (post.metadata.get('metadata') or {}).get('capture_sources', post.metadata.get('capture_sources'))
        if sources:
            stack.enter_context(capture_scope(sources))
        require_capture_allowed()
        include_capture_paths([src, dst])
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            return "skipped"
        if not brief:
            post.metadata.setdefault("created", iso_created(src))
        tags = post.metadata.get("tags", [])
        if isinstance(tags, str):
            tags = [tags]
        tag = 'ops-brief' if brief else 'memory'
        if tag not in tags:
            tags.append(tag)
        post.metadata["tags"] = tags
        post.metadata["source_path"] = str(src)
        post.metadata["mirrored_from"] = origin
        post.metadata["mirrored_by"] = machine
        capture = current_capture_sources()
        if capture:
            metadata = post.metadata.setdefault('metadata', {})
            metadata['capture_sources'] = capture
            metadata['capture_policy'] = require_capture_allowed()
        if dry_run:
            return "mirrored"
        require_capture_allowed()
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(".md.tmp")
        try:
            tmp.write_text(frontmatter.dumps(post))
            tmp.chmod(0o600)
            require_capture_allowed()
            os.replace(tmp, dst)
        finally:
            tmp.unlink(missing_ok=True)
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


def run(home: Path | None = None, dry_run: bool = False, operator: bool = False) -> dict:  # branch-divergence: intentional — no source dir means nothing to mirror or prune
    projects, vault_memory, machine = settings(home)
    home = home or Path.home()
    policy = read_capture_policy()
    if policy['state'] == 'invalid':
        print('capture deferred: invalid_policy', file=sys.stderr)
        return {'error': 'capture-policy'}
    native = [(home/'.hermes/engram-memory', 'hermes'), (home/'.openclaw/engram-memory', 'openclaw')] if operator else []
    if not projects.is_dir() and not any(root.is_dir() for root, _ in native):
        print(f"no memory source at {projects}" if policy["state"] == "legacy" else "no memory source", file=sys.stderr)
        return {"error": "no-source"}
    if not dry_run:
        vault_memory.mkdir(parents=True, exist_ok=True)
    counts = {"mirrored": 0, "skipped": 0, "pruned": 0}
    current, owned = set(), set()
    for proj in sorted(projects.iterdir()) if projects.is_dir() else []:
        mem = proj / "memory"
        if not mem.is_dir():
            continue
        slug = slug_for(proj.name)
        owned.add(slug)
        for src in mem.glob("*.md"):
            dst = vault_memory / slug / src.name
            current.add(dst)
            try:
                counts[mirror_one(src, dst, proj.name, machine, dry_run)] += 1
            except CapturePolicyBlocked:
                counts['skipped'] += 1

    for base, prefix in native:
        if not base.is_dir():
            continue
        for persona in sorted(base.iterdir()):
            if not persona.is_dir():
                continue
            for project in sorted(persona.iterdir()):
                if not project.is_dir():
                    continue
                slug = f"{prefix}-{persona.name}-{project.name}"[:80]
                owned.add(slug)
                for src in project.glob('*.md'):
                    dst = vault_memory/slug/src.name; current.add(dst)
                    try:
                        counts[mirror_one(src, dst, f"{prefix}:{persona.name}/{project.name}", machine, dry_run)] += 1
                    except CapturePolicyBlocked:
                        counts['skipped'] += 1
    if operator:
        roots = [home/'Projects', home/'Projects/CoWork Library']
        briefs = [src for root in roots if root.is_dir() for src in sorted(root.glob('*/BRIEF.md'))]
        for src in briefs:
            dst = vault_memory.parent/'Briefs'/f'{src.parent.name}.md'
            try:
                candidates = [str(p.parent) for p in briefs if p.parent.name == src.parent.name]
                with bound_document_capture(src, dst, candidates) as bound:
                    counts[mirror_one(src, dst, src.parent.name, machine, dry_run,
                        post=frontmatter.loads(bound.projection), brief=True)] += 1
            except CapturePolicyBlocked:
                counts['skipped'] += 1

    # Prune only copies this machine mirrored, inside slugs it produces. Legacy files
    # without mirrored_by are never pruned.
    if vault_memory.is_dir() and policy["state"] == "legacy":
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
    if vault_memory.is_dir() and policy["state"] == "legacy":
        for d in sorted(x for x in vault_memory.iterdir() if x.is_dir()):
            if "__" in d.name or (operator and any(d.name.startswith(prefix + "-") for _, prefix in native)) or _all_generated(d):
                continue
            orphans.append((d.name, len(list(d.rglob("*.md")))))
    tag = "[dry-run] " if dry_run else ""
    location = f" → {vault_memory}" if policy["state"] == "legacy" else ""
    print(f"{tag}mirrored={counts['mirrored']} skipped={counts['skipped']} pruned={counts['pruned']}{location}")
    for name, n in orphans:
        print(f"{tag}WARNING: orphaned slug dir {name}/ ({n} notes) has no producer", file=sys.stderr)
    return {**counts, "orphans": [o[0] for o in orphans]}


def main() -> int:
    result = run(dry_run="--dry-run" in sys.argv, operator="--operator" in sys.argv)
    return 1 if result.get("error") else 0


if __name__ == "__main__":
    sys.exit(main())
