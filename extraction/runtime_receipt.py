#!/usr/bin/env python3
"""Write a source-bound receipt for the deployed Engram extraction runtime."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any


GIT_OID = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")


class RuntimeReceiptError(ValueError):
    """The runtime identity is incomplete or does not match deployed bytes."""


def _validate_text(value: str, label: str) -> str:
    if not value:
        raise RuntimeReceiptError(f"{label} must be nonempty")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise RuntimeReceiptError(f"{label} contains a control character")
    return value


def _validate_sha256(value: str, label: str) -> str:
    if not SHA256.fullmatch(value):
        raise RuntimeReceiptError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _file_sha256(path: Path) -> str:
    try:
        with path.open("rb") as handle:
            digest = hashlib.sha256()
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
            return digest.hexdigest()
    except OSError as exc:
        raise RuntimeReceiptError(f"cannot read deployed file {path}: {exc}") from exc


def _verified_file(path: Path, expected_sha256: str, label: str) -> dict[str, str]:
    expected = _validate_sha256(expected_sha256, f"expected {label} SHA-256")
    resolved = path.resolve()
    actual = _file_sha256(resolved)
    if actual != expected:
        raise RuntimeReceiptError(
            f"{label} SHA-256 mismatch: expected {expected}, observed {actual}"
        )
    return {"path": str(resolved), "sha256": actual}


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def write_runtime_receipt(
    *,
    revision: str,
    repository_slug: str,
    target_id: str,
    workspace_id: str,
    session_id: str,
    marker_id: str,
    runner_path: Path,
    expected_runner_sha256: str,
    extractor_path: Path,
    expected_extractor_sha256: str,
    output_path: Path,
    recorded_at: str | None = None,
) -> dict[str, Any]:
    if not GIT_OID.fullmatch(revision):
        raise RuntimeReceiptError("revision must be a 40-character lowercase Git OID")
    payload: dict[str, Any] = {
        "schema": "engram.runtime-receipt.v1",
        "recordedAt": recorded_at or _utc_now(),
        "repositorySlug": _validate_text(repository_slug, "repository slug"),
        "revision": revision,
        "targetId": _validate_text(target_id, "target id"),
        "workspaceId": _validate_text(workspace_id, "workspace id"),
        "sessionId": _validate_text(session_id, "session id"),
        "markerId": _validate_text(marker_id, "marker id"),
        "files": {
            "runner": _verified_file(
                runner_path, expected_runner_sha256, "runner"
            ),
            "extractor": _verified_file(
                extractor_path, expected_extractor_sha256, "extractor"
            ),
        },
    }
    canonical = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    payload["receiptDigest"] = hashlib.sha256(canonical).hexdigest()
    _atomic_write_json(output_path, payload)
    return payload


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    parser.add_argument("--repository-slug", required=True)
    parser.add_argument("--target-id", required=True)
    parser.add_argument("--workspace-id", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--marker-id", required=True)
    parser.add_argument("--runner", required=True, type=Path)
    parser.add_argument("--runner-sha256", required=True)
    parser.add_argument("--extractor", required=True, type=Path)
    parser.add_argument("--extractor-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        receipt = write_runtime_receipt(
            revision=args.revision,
            repository_slug=args.repository_slug,
            target_id=args.target_id,
            workspace_id=args.workspace_id,
            session_id=args.session_id,
            marker_id=args.marker_id,
            runner_path=args.runner,
            expected_runner_sha256=args.runner_sha256,
            extractor_path=args.extractor,
            expected_extractor_sha256=args.extractor_sha256,
            output_path=args.output,
        )
    except RuntimeReceiptError as exc:
        print(f"runtime receipt refused: {exc}", file=sys.stderr)
        return 64
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
