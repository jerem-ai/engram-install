"""Project routing evidence shared with runtime/src/lib/project-identity.ts.

Only observe_repository supplies repository metadata. IDs never authenticate an
actor or grant access. No network lookup, markers, basename or substring matching.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess

SCHEMA = "engram.project-identity.v1"
EMPTY = {"schema": SCHEMA, "projects": []}
_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\Z")


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def normalize_repository_remote(value):
    if not isinstance(value, str) or len(value) > 2048 or not re.fullmatch(r"[!-~]+", value):
        return None
    scp = re.fullmatch(r"git@([A-Za-z0-9.-]+):(.+)", value)
    if scp:
        scheme, host, port, repo = "ssh", scp[1], "", scp[2]
    else:
        url = re.fullmatch(r"(https|ssh|git)://(git@)?([A-Za-z0-9.-]+)(?::([0-9]+))?/(.+)", value)
        if not url or (url[2] and url[1] != "ssh"):
            return None
        scheme, _, host, port, repo = url.groups()
        port = port or ""
    host = host.lower()
    if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label) for label in host.split(".")):
        return None
    if port:
        if not 1 <= int(port) <= 65535:
            return None
        port = str(int(port))
        if port == {"https": "443", "ssh": "22", "git": "9418"}[scheme]:
            port = ""
    repo = re.sub(r"/$", "", repo)
    repo = re.sub(r"\.git$", "", repo)
    if not repo or not re.fullmatch(r"[A-Za-z0-9._/-]+", repo) or any(p in ("", ".", "..") for p in repo.split("/")):
        return None
    return f"remote:{host}{':' + port if port else ''}/{repo}"


def _parse_config(cfg):
    if (not isinstance(cfg, dict) or set(cfg) - {"schema", "projects"}
            or cfg.get("schema") != SCHEMA or not isinstance(cfg.get("projects"), list)
            or len(cfg["projects"]) > 10000):
        raise ValueError("invalid_config")
    ids, stable_ids, remotes, roots, stores = set(), set(), {}, {}, set()
    for item in cfg["projects"]:
        if (not isinstance(item, dict) or set(item) - {"id", "stable_id", "aliases", "remotes", "roots", "legacy_stores"}
                or not isinstance(item.get("id"), str) or not _ID.fullmatch(item["id"])):
            raise ValueError("invalid_config")
        stable = item.get('stable_id', f'project:{_digest("configured:" + item["id"])}')
        if not isinstance(stable, str) or not re.fullmatch(r'project:[a-f0-9]{64}', stable) or stable in stable_ids:
            raise ValueError('ambiguous_config')
        stable_ids.add(stable)
        for key in ("aliases", "remotes", "roots", "legacy_stores"):
            if key in item and (not isinstance(item[key], list) or any(not isinstance(x, str) for x in item[key])):
                raise ValueError("invalid_config")
        for store in item.get('legacy_stores', []):
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,512}', store) or store.lower() in stores:
                raise ValueError('ambiguous_config')
            stores.add(store.lower())
        for name in [item["id"], *item.get("aliases", [])]:
            if not _ID.fullmatch(name) or name in ids:
                raise ValueError("ambiguous_config")
            ids.add(name)
        for raw in item.get("remotes", []):
            remote = normalize_repository_remote(raw)
            if not remote:
                raise ValueError("invalid_config")
            if remote in remotes and remotes[remote] != item["id"]:
                raise ValueError("ambiguous_config")
            remotes[remote] = item["id"]
        for root in item.get("roots", []):
            if not root.startswith("/") or "\0" in root or any(x in (".", "..") for x in root.split("/")) or root.endswith("/"):
                raise ValueError("invalid_config")
            if root in roots and roots[root] != item["id"]:
                raise ValueError("ambiguous_config")
            roots[root] = item["id"]
    return cfg


def resolve_project_identity(observation, config=EMPTY, explicit_id=None):
    cfg = config
    result = {"schema": SCHEMA, "status": "unknown", "reason": "unverified_repository",
              "project_id": None, "worktree_id": None, "config_fingerprint": _digest(None)}
    try:
        _parse_config(cfg)
        result["config_fingerprint"] = _digest(cfg)
        if (not observation or not observation.get("host_id") or not observation.get("worktree", "").startswith("/")
                or not observation.get("common_dir", "").startswith("/") or not isinstance(observation.get("remotes"), list)):
            return result
        candidates = set()
        for project in cfg["projects"]:
            if observation["common_dir"] in project.get("roots", []):
                candidates.add(f'configured:{project["id"]}')
        if explicit_id is not None:
            matched = next((p for p in cfg["projects"] if p["id"] == explicit_id or explicit_id in p.get("aliases", [])), None)
            if matched is None:
                return {**result, "reason": "unknown_explicit_id"}
            candidates.add(f'configured:{matched["id"]}')
        remote_candidates = set()
        for raw in observation["remotes"]:
            remote = normalize_repository_remote(raw)
            if not remote:
                return {**result, "reason": "invalid_remote"}
            matched = next((p for p in cfg["projects"] if any(normalize_repository_remote(r) == remote for r in p.get("remotes", []))), None)
            remote_candidates.add(f'configured:{matched["id"]}' if matched else remote)
        if len(remote_candidates) > 1:
            return {**result, "reason": "ambiguous_repository"}
        candidates.update(remote_candidates)
        configured = [x for x in candidates if x.startswith("configured:")]
        if len(configured) == 1:
            candidates = {x for x in candidates if not x.startswith("remote:")}
        if len(candidates) > 1:
            return {**result, "reason": "ambiguous_repository"}
        key = next(iter(candidates), f'local:{_digest([observation["host_id"], observation["common_dir"]])}')
        project_id = f"project:{_digest(key)}"
        if configured:
            project_id = next(p for p in cfg['projects'] if f'configured:{p["id"]}' == key).get('stable_id', project_id)
        return {**result, "status": "verified", "reason": "configured" if configured else "remote" if observation["remotes"] else "local",
                "project_id": project_id, "worktree_id": f'worktree:{_digest([project_id, observation["host_id"], observation["worktree"]])}'}
    except (ValueError, TypeError, AttributeError) as error:
        return {**result, "reason": "ambiguous_config" if str(error) == "ambiguous_config" else "invalid_config"}


def check_capture_routing(source, storage, routed):
    """Qualify an existing destination; never choose or move a memory store."""
    if source["reason"] in ("invalid_config", "ambiguous_config", "invalid_remote", "ambiguous_repository", "unknown_explicit_id"):
        return {"allowed": False, "reason": "identity_invalid"}
    if not routed:
        return {"allowed": True, "reason": "isolated_verified" if source["status"] == "verified" else "isolated_unverified"}
    if source["status"] != "verified" or not storage or storage["status"] != "verified":
        return {"allowed": False, "reason": "routing_unverified"}
    if source["project_id"] != storage["project_id"]:
        return {"allowed": False, "reason": "routing_conflict"}
    return {"allowed": True, "reason": "routing_verified"}


def observe_repository(cwd, host_id=None):
    """Bounded read-only Git probes. Missing/deleted/non-Git paths remain unknown."""
    try:
        directory = str(Path(cwd).resolve(strict=True))
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(GIT_OPTIONAL_LOCKS="0", GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)

        def git(*args, absent_ok=False):
            proc = subprocess.run(["git", "-C", directory, *args], env=env, capture_output=True, timeout=2, check=False)
            if proc.returncode == 1 and absent_ok:
                return ""
            if proc.returncode != 0 or len(proc.stdout) > 65536:
                raise ValueError("unverified_repository")
            return proc.stdout.decode("utf8", errors="strict").strip()

        worktree = str(Path(git("rev-parse", "--show-toplevel")).resolve(strict=True))
        common_dir = str(Path(git("rev-parse", "--path-format=absolute", "--git-common-dir")).resolve(strict=True))
        remotes = git("config", "--get-all", "remote.origin.url", absent_ok=True).splitlines()
        return {"host_id": host_id or socket.gethostname(), "worktree": worktree, "common_dir": common_dir, "remotes": remotes}
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


if __name__ == "__main__":
    import sys
    # Fixture entry point is also used by the cross-language parity test.
    request = json.load(sys.stdin)
    print(json.dumps(resolve_project_identity(request.get("observation"), request.get("config", EMPTY), request.get("explicit_id"))))
