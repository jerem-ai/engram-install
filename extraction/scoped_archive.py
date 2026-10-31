"""Source-bound, immutable native transcript versions in an existing archive.

Legacy copies and indexes remain untouched. Bind the full native revision before
spooling, and publish its compressed bytes and receipt together. Exclusion keeps
old copies retained while current verification withholds them. This local guard
does not implement C3 dispatch/erasure serialization.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import tempfile
import uuid

from capture_binding import bound_file_archive, MAX_SOURCE_BYTES
from capture_policy import (CapturePolicyBlocked, capture_path_allowed, capture_scope,
                            current_capture_sources, include_capture_paths, read_capture_policy,
                            require_capture_allowed)

SCHEMA = 'engram.transcript-archive.v1'
CHUNK = 1024 * 1024
RECEIPT_LIMIT = 1024 * 1024


def logical_path(store, relative):
    value = PurePosixPath(store) / PurePosixPath(relative)
    text = str(value)
    if (value.is_absolute() or '..' in value.parts or len(value.parts) < 2
            or any(ord(char) < 32 or ord(char) == 127 for char in text)
            or '\\' in text or len(text.encode('utf8')) > 4096):
        raise CapturePolicyBlocked('archive_path_invalid')
    return text


def owned_file(path, limit=None, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & (0o077 if private else 0o022) or (limit is not None and info.st_size > limit)):
            raise CapturePolicyBlocked('archive_file_invalid')
        return os.fdopen(fd, 'rb')
    except BaseException:
        os.close(fd)
        raise


def checked_digest(path):
    digest = hashlib.sha256()
    with owned_file(path, private=True) as stream:
        while True:
            require_capture_allowed()
            block = stream.read(CHUNK)
            if not block:
                break
            require_capture_allowed()
            digest.update(block)
    require_capture_allowed()
    return digest.hexdigest()


def private_directory(path):
    if path.is_symlink():
        raise CapturePolicyBlocked('archive_directory_invalid')
    missing = []
    parent = path
    while not parent.exists():
        missing.append(parent); parent = parent.parent
    for folder in reversed(missing):
        folder.mkdir(mode=0o700, exist_ok=True)
        sync_directory(folder.parent)
    info = path.stat()
    if not path.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise CapturePolicyBlocked('archive_directory_invalid')


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(data); out.flush(); os.fsync(out.fileno())


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def archive_lock(versions):
    include_capture_paths([versions, versions/'.lock'])
    require_capture_allowed()
    private_directory(versions)
    fd = os.open(versions/'.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise CapturePolicyBlocked('archive_lock_invalid')
        fcntl.flock(fd, fcntl.LOCK_EX)
        require_capture_allowed()
        yield
    finally:
        os.close(fd)


def verify_archive(receipt_path):
    """Verify one currently eligible version without returning source content."""
    receipt_path = Path(receipt_path).absolute()
    policy = read_capture_policy()
    if not capture_path_allowed(policy, receipt_path):
        raise CapturePolicyBlocked('path_excluded')
    with owned_file(receipt_path, RECEIPT_LIMIT, private=True) as stream:
        receipt = json.loads(stream.read(RECEIPT_LIMIT + 1))
    if (not isinstance(receipt, dict) or receipt.get('schema') != SCHEMA or type(receipt.get('source_bytes')) is not int
            or not 0 <= receipt['source_bytes'] <= MAX_SOURCE_BYTES
            or receipt.get('source_sha256') != receipt_path.parent.name
            or not re.fullmatch(r'[a-f0-9]{64}', receipt_path.parent.name)
            or type(receipt.get('stored_bytes')) is not int or not 0 < receipt['stored_bytes'] <= MAX_SOURCE_BYTES + 16 * CHUNK
            or not isinstance(receipt.get('logical_path'), str) or '/' not in receipt['logical_path']
            or receipt.get('runtime') not in ('claude-code', 'codex', 'openclaw', 'hermes')):
        raise CapturePolicyBlocked('archive_receipt_invalid')
    logical_path(*receipt['logical_path'].split('/', 1))
    if receipt['runtime'] == 'hermes' and (receipt.get('source_format') != 'engram.hermes-session.v1'
            or not receipt['logical_path'].startswith('hermes-sessions/sqlite/')):
        raise CapturePolicyBlocked('archive_receipt_invalid')
    with capture_scope(receipt.get('capture_sources')):
        if not all(source['revision'] == receipt['source_sha256']
                   and source['source_id'].startswith(receipt['runtime'] + ':') for source in current_capture_sources()):
            raise CapturePolicyBlocked('archive_receipt_invalid')
        compressed = receipt_path.parent/'transcript.jsonl.gz'
        include_capture_paths([receipt_path, compressed])
        if checked_digest(compressed) != receipt.get('stored_sha256'):
            raise CapturePolicyBlocked('archive_copy_changed')
        digest = hashlib.sha256(); total = 0
        with owned_file(compressed, private=True) as raw, gzip.GzipFile(fileobj=raw, mode='rb') as source:
            while True:
                require_capture_allowed()
                block = source.read(CHUNK)
                if not block:
                    break
                require_capture_allowed()
                total += len(block)
                if total > receipt['source_bytes']:
                    raise CapturePolicyBlocked('archive_copy_changed')
                digest.update(block)
        require_capture_allowed()
        if total != receipt['source_bytes'] or digest.hexdigest() != receipt['source_sha256']:
            raise CapturePolicyBlocked('archive_copy_changed')
        return {'status': 'verified', 'bytes': total, 'sha256': digest.hexdigest()}


def locator_key(source):
    """Same exact-version identity as runtime selected-transcript.ts."""
    identity = [source[key] for key in ('source_id', 'revision', 'project_id', 'worktree_id')]
    return hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def publish_locators(root, receipt_path):
    """Verify and publish missing per-source locators; existing rows need no rewrite."""
    root, receipt_path = Path(root), Path(receipt_path)
    if not capture_path_allowed(read_capture_policy(), receipt_path):
        raise CapturePolicyBlocked('path_excluded')
    with owned_file(receipt_path, RECEIPT_LIMIT, private=True) as stream:
        raw = stream.read(RECEIPT_LIMIT + 1)
    receipt = json.loads(raw)
    directory = root/'.source-locators'
    with capture_scope(receipt['capture_sources']):
        include_capture_paths([directory, receipt_path])
        with archive_lock(directory):
            rows = []
            for source in receipt['capture_sources']:
                path = directory/(locator_key(source) + '.json')
                include_capture_paths([path]); require_capture_allowed()
                row = {'schema': 'engram.transcript-locator.v1',
                       'source_id': source['source_id'], 'revision': source['revision'],
                       'project_id': source['project_id'], 'worktree_id': source['worktree_id'],
                       'receipt': receipt_path.relative_to(root).as_posix(),
                       'receipt_sha256': hashlib.sha256(raw).hexdigest()}
                if path.exists():
                    with owned_file(path, RECEIPT_LIMIT, private=True) as stream:
                        old = json.load(stream)
                    if old.get('receipt') != row['receipt']:
                        raise CapturePolicyBlocked('archive_locator_ambiguous')
                    if old == row:
                        continue
                rows.append((path, row))
            if not rows:
                require_capture_allowed()
                return False
            verify_archive(receipt_path)
            # The metadata being indexed must still be the verified receipt.
            with owned_file(receipt_path, RECEIPT_LIMIT, private=True) as stream:
                if stream.read(RECEIPT_LIMIT + 1) != raw:
                    raise CapturePolicyBlocked('archive_receipt_changed')
            for path, row in rows:
                scratch = directory/('.pending-' + uuid.uuid4().hex)
                include_capture_paths([scratch]); require_capture_allowed()
                try:
                    write_private(scratch, (json.dumps(row, sort_keys=True, ensure_ascii=False)+'\n').encode())
                    require_capture_allowed()
                    os.replace(scratch, path);sync_directory(directory)
                    require_capture_allowed()
                finally:
                    scratch.unlink(missing_ok=True)
            return True


def repair_locators(root):
    """Recover publication after a crash, including when native inputs expired."""
    repaired, deferred = 0, 0
    for receipt in sorted(Path(root).rglob('receipt.json')):
        if not re.fullmatch('[a-f0-9]{64}', receipt.parent.name) or not receipt.parent.parent.name.endswith('.versions'):
            continue
        try:
            repaired += publish_locators(root, receipt)
        except (CapturePolicyBlocked, OSError, ValueError, EOFError, KeyError, TypeError):
            deferred += 1
    return repaired, deferred


def _archive_stream(root, logical, versions, runtime, revision, stream, current, replica_root=None, source_format=None):
    current()
    final = versions/revision
    include_capture_paths([final, final/'transcript.jsonl.gz', final/'receipt.json'])
    if replica_root is not None:
        replica = Path(replica_root)/(logical + '.versions')/revision
        include_capture_paths([replica, replica/'transcript.jsonl.gz', replica/'receipt.json'])
    with archive_lock(versions):
        expected_sources = current_capture_sources()
        if final.exists():
            result = verify_archive(final/'receipt.json')
            with owned_file(final/'receipt.json', RECEIPT_LIMIT, private=True) as stream:
                old = json.load(stream)
            if old['capture_sources'] != expected_sources:
                raise CapturePolicyBlocked('archive_binding_changed')
            require_capture_allowed()
            publish_locators(root, final/'receipt.json')
            current()
            return {**result, 'status': 'retained', 'receipt': str(final/'receipt.json')}
        scratch = Path(tempfile.mkdtemp(prefix='.pending-', dir=versions))
        receipt_bytes = None; published = False; compressed_stat = None
        try:
            scratch.chmod(0o700)
            include_capture_paths([scratch])
            compressed = scratch/'transcript.jsonl.gz'
            include_capture_paths([compressed, scratch/'receipt.json'])
            digest = hashlib.sha256(); total = 0
            fd = os.open(compressed, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as raw:
                with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as out:
                    for block in stream():
                        require_capture_allowed()
                        total += len(block)
                        if total > MAX_SOURCE_BYTES:
                            raise CapturePolicyBlocked('source_size_limit')
                        digest.update(block); out.write(block)
                raw.flush(); os.fsync(raw.fileno())
            current()
            if digest.hexdigest() != revision:
                raise CapturePolicyBlocked('source_changed')
            # Temporary paths constrain writing but are not lasting source dependencies.
            receipt = {'schema': SCHEMA, 'source_sha256': digest.hexdigest(), 'source_bytes': total,
                'logical_path': logical, 'runtime': runtime, 'capture_sources': expected_sources,
                'capture_policy': require_capture_allowed(), 'stored_sha256': checked_digest(compressed),
                'stored_bytes': compressed.stat().st_size,
                **({'source_format': source_format} if source_format else {}),
                'created_at': dt.datetime.now(dt.timezone.utc).isoformat()}
            receipt_bytes = (json.dumps(receipt, sort_keys=True, ensure_ascii=False) + '\n').encode()
            write_private(scratch/'receipt.json', receipt_bytes)
            sync_directory(scratch)
            require_capture_allowed()
            compressed_stat = compressed.stat()
            current()
            os.rename(scratch, final); published = True
            sync_directory(versions)
            require_capture_allowed()
            verify_archive(final/'receipt.json')
            require_capture_allowed()
            publish_locators(root, final/'receipt.json')
            current()
            return {'status': 'archived', 'bytes': total, 'sha256': digest.hexdigest(), 'receipt': str(final/'receipt.json')}
        except BaseException:
            # Undo only this unpublished/new version. Earlier versions stay untouched.
            if published and (final/'receipt.json').read_bytes() == receipt_bytes:
                named_info = (final/'transcript.jsonl.gz').stat()
                if (named_info.st_ino, named_info.st_size, named_info.st_mtime_ns) == (compressed_stat.st_ino, compressed_stat.st_size, compressed_stat.st_mtime_ns):
                    shutil.rmtree(final)
            raise
        finally:
            if scratch.exists():
                shutil.rmtree(scratch)



def archive_version(root, store, tree, source, runtime, replica_root=None):
    root, tree, source = Path(root).resolve(), Path(tree), Path(source)
    logical = logical_path(store, source.relative_to(tree).as_posix())
    versions = root/(logical + '.versions')
    if not versions.resolve().is_relative_to(root):
        raise CapturePolicyBlocked('archive_path_invalid')
    with bound_file_archive(source, runtime, versions) as bound:
        def stream():
            with owned_file(source, MAX_SOURCE_BYTES) as src:
                before = os.fstat(src.fileno()); total = 0
                while True:
                    require_capture_allowed()
                    block = src.read(CHUNK)
                    if not block:
                        break
                    total += len(block)
                    if total > before.st_size:
                        raise CapturePolicyBlocked('source_changed')
                    yield block
                after = os.fstat(src.fileno())
                if (total != before.st_size or (before.st_ino, before.st_size, before.st_mtime_ns)
                        != (after.st_ino, after.st_size, after.st_mtime_ns)):
                    raise CapturePolicyBlocked('source_changed')
        return _archive_stream(root, logical, versions, runtime, bound.source['revision'], stream,
                               require_capture_allowed, replica_root)


def archive_hermes_version(root, state, session_id, replica_root=None):
    from hermes_capture import bound_hermes_snapshot
    from hermes_snapshot import SCHEMA as source_format
    root = Path(root).resolve()
    logical = logical_path('hermes-sessions', 'sqlite/' + hashlib.sha256(session_id.encode('utf8')).hexdigest() + '.jsonl')
    versions = root/(logical + '.versions')
    if not versions.resolve().is_relative_to(root):
        raise CapturePolicyBlocked('archive_path_invalid')
    with bound_hermes_snapshot(state, session_id, versions) as bound:
        return _archive_stream(root, logical, versions, 'hermes', bound.source['revision'], bound.stream,
                               bound.current, replica_root, source_format)


def hermes_session_ids(path):
    from hermes_snapshot import ReadDatabase, text
    if not capture_path_allowed(read_capture_policy(), path):
        raise CapturePolicyBlocked('path_excluded')
    db = None
    try:
        db = ReadDatabase(path)
        rows = db.reader.execute('SELECT id FROM sessions ORDER BY id LIMIT 100001').fetchall()
        if len(rows) > 100000:
            raise CapturePolicyBlocked('source_metadata_limit')
        ids = [text(row[0]) for row in rows]
        db.current()
        return ids
    except sqlite3.Error:
        raise CapturePolicyBlocked('hermes_snapshot_unavailable') from None
    finally:
        if db is not None:
            db.close()


def archive_selected(root, trees, replica_root=None):
    result = {'selected': True, 'added': 0, 'updated': 0, 'versioned': 0, 'sessions': 0,
              'retained': 0, 'locators_repaired': 0, 'locators_deferred': 0,
              'policy_deferred_sources': 0, 'unsupported_stores': 0, 'errors': 0, 'policy_deferred': False}
    snapshot = read_capture_policy()
    if (snapshot['state'] == 'invalid' or not capture_path_allowed(snapshot, root)
            or (replica_root is not None and not capture_path_allowed(snapshot, replica_root))):
        return {**result, 'policy_deferred': True}
    result['locators_repaired'], result['locators_deferred'] = repair_locators(root)
    runtimes = {'claude-projects': 'claude-code', 'codex-sessions': 'codex', 'codex-archived': 'codex',
                'openclaw-agents': 'openclaw'}
    for store, tree in trees:
        if store == 'hermes-state':
            if not Path(tree).exists():
                continue
            try:
                ids = hermes_session_ids(tree)
            except CapturePolicyBlocked:
                result['policy_deferred_sources'] += 1
                continue
            except (OSError, ValueError):
                result['errors'] += 1
                continue
            for session in ids:
                try:
                    saved = archive_hermes_version(root, tree, session, replica_root)
                    result['added' if saved['status'] == 'archived' else 'retained'] += 1
                    result['sessions'] += 1
                except CapturePolicyBlocked:
                    result['policy_deferred_sources'] += 1
                except (OSError, ValueError, EOFError):
                    result['errors'] += 1
            continue
        if store not in runtimes:
            # An absent legacy tree carries no missing preservation coverage.
            if Path(tree).exists() and (not Path(tree).is_dir() or any(Path(tree).iterdir())):
                result['unsupported_stores'] += 1
            continue
        for source in sorted(Path(tree).rglob('*.jsonl')):
            try:
                try:
                    saved = archive_version(root, store, tree, source, runtimes[store], replica_root)
                except CapturePolicyBlocked as error:
                    # OpenClaw's existing archive tree also holds native Codex homes.
                    # Classify their envelope before copying and keep the old path.
                    if store != 'openclaw-agents' or error.reason != 'source_runtime_mismatch':
                        raise
                    saved = archive_version(root, store, tree, source, 'codex', replica_root)
                result['added' if saved['status'] == 'archived' else 'retained'] += 1
                result['sessions'] += 1
            except CapturePolicyBlocked:
                result['policy_deferred_sources'] += 1
            except (OSError, ValueError, EOFError):
                result['errors'] += 1
    result['policy_deferred'] = (result['policy_deferred_sources'] > 0 or result['locators_deferred'] > 0
        or result['unsupported_stores'] > 0 or result['errors'] > 0
        or (snapshot['state'] == 'valid' and snapshot['policy']['default'] == 'deny' and not result['sessions']))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--verify', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify_archive(args.verify)))
    except (CapturePolicyBlocked, OSError, ValueError, EOFError):
        print('transcript archive deferred: source_context_unknown')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
