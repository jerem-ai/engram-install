"""Bind a bounded source snapshot to verified routing before extraction sees it.

Native cwd and structured file arguments are metadata, never authorization. Shell
commands and quoted prose are not a complete file-access trace. Exclude the
project when that distinction matters. This module does not advance any cursor.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile

from capture_policy import (CapturePolicyBlocked, OPENCLAW_BINDING_REVISION, canonical_capture_path, capture_scope,
                            current_capture_sources, read_capture_policy, require_capture_allowed, valid_capture_path)
from project_identity import EMPTY, check_capture_routing, observe_repository, resolve_project_identity
from source_turns import HermesTurnIndex, JsonlTurnIndex, source_turn_scope

MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024
MAX_RAW_SNAPSHOT_BYTES = 64 * 1024 * 1024
MAX_RECORD_BYTES = 32 * 1024 * 1024
MAX_RECORDS = 1000000
FILE_TOOLS = {'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'read_file', 'write_file', 'edit_file'}


def encode_project_directory(cwd):
    return re.sub(r'[^A-Za-z0-9-]', '-', cwd)


def _identity_config():
    path = Path.home()/'.config/engram/project-identity.json'
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536 or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise CapturePolicyBlocked('identity_invalid')
        data = bytearray()
        while len(data) <= 65536:
            chunk = os.read(fd, 65537 - len(data))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > 65536:
            raise CapturePolicyBlocked('identity_invalid')
        return json.loads(data.decode('utf8', errors='strict'))
    except FileNotFoundError:
        return EMPTY
    except (OSError, ValueError):
        raise CapturePolicyBlocked('identity_invalid') from None
    finally:
        if fd is not None:
            os.close(fd)


def _native_cwd(record):
    value = record.get('cwd', record.get('workspaceDir'))
    if record.get('type') in ('session_meta', 'turn_context') and isinstance(record.get('payload'), dict):
        value = record['payload'].get('cwd', value)
    return value if isinstance(value, str) else None


def _structured_paths(record, cwd):
    if not cwd:
        return []
    message = record.get('message') if isinstance(record.get('message'), dict) else {}
    blocks = message.get('content', [])
    if not isinstance(blocks, list):
        blocks = []
    if record.get('type') == 'response_item' and isinstance(record.get('payload'), dict):
        blocks = [*blocks, record['payload']]
    out = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        name = block.get('name')
        args = block.get('input', block.get('arguments'))
        if isinstance(args, str) and name in FILE_TOOLS:
            try:
                args = json.loads(args)
            except ValueError:
                continue
        if name in FILE_TOOLS and isinstance(args, dict):
            values = [args[k] for k in ('file_path', 'path', 'notebook_path') if isinstance(args.get(k), str)]
        elif name == 'apply_patch' and isinstance(args, str):
            values = re.findall(r'^\*\*\* (?:Add|Update|Delete) File: (.+)$', args, re.M)
        else:
            continue
        for value in values:
            path = canonical_capture_path(str(Path(cwd)/value))
            if not valid_capture_path(path):
                raise CapturePolicyBlocked('source_metadata_invalid')
            out.append(path)
    return out


def _openclaw_structured_paths(record, cwd):
    """Native message blocks and compiled-context calls, excluding quoted text."""
    messages = [record.get('message')]
    data = record.get('data')
    if record.get('type') == 'context.compiled' and isinstance(data, dict) and isinstance(data.get('messages'), list):
        messages.extend(data['messages'])
    paths = set()
    aliases = {'read': 'read_file', 'write': 'write_file', 'edit': 'edit_file'}
    for message in messages:
        if not isinstance(message, dict):
            continue
        blocks = ([block for block in message['content'] if isinstance(block, dict)
                   and block.get('type') in ('toolCall', 'tool_use', 'function_call')]
                  if isinstance(message.get('content'), list) else [])
        calls = message.get('tool_calls')
        for call in calls if isinstance(calls, list) else []:
            if isinstance(call, dict) and isinstance(call.get('function'), dict):
                blocks.append(call['function'])
        normalized = [{**block, 'name': aliases.get(block.get('name'), block.get('name'))}
                      for block in blocks if isinstance(block, dict) and isinstance(block.get('name'), str)]
        paths.update(_structured_paths({'message': {'content': normalized}}, cwd))
        if len(paths) > 4096:
            raise CapturePolicyBlocked('source_metadata_limit')
    return paths


def _target_candidates(store):
    """Recover candidate paths, then verify Git independently of transcript text."""
    out = set()
    projects = Path.home()/'Projects'
    if projects.is_dir():
        for path in list(projects.iterdir())[:1024]:
            if path.is_dir() and encode_project_directory(str(path)) == store.name:
                out.add(str(path))
    files = sorted(store.glob('*.jsonl'))
    if len(files) > 4096:
        raise CapturePolicyBlocked('routing_inventory_limit')
    for path in files:
        found = False
        try:
            with path.open('rb') as fh:
                remaining = 1024 * 1024
                for _ in range(64):
                    line = fh.readline(remaining + 1)
                    remaining -= len(line)
                    if not line or remaining < 0:
                        break
                    if not line.strip():
                        continue
                    record = json.loads(line)
                    cwd = _native_cwd(record) if isinstance(record, dict) else None
                    if cwd and valid_capture_path(cwd) and encode_project_directory(cwd) == store.name:
                        out.add(cwd)
                        found = True
        except (OSError, ValueError):
            pass
        if not found:
            out.add(None)
    return out


def qualify_capture_route(source_store, destination, observation, identity, config):
    destination, source_store = Path(destination), Path(source_store)
    routed = destination.resolve() != (source_store/'memory').resolve()
    storage = None
    if identity['status'] == 'verified':
        # Explicit aliases are local configuration, never names inferred from prose.
        for project in config.get('projects', []):
            if destination.parent.name in project.get('legacy_stores', []):
                alias = resolve_project_identity(observation, config, project['id'])
                if alias['project_id'] == identity['project_id']:
                    storage = alias
        candidates = _target_candidates(destination.parent)
        observed = [resolve_project_identity(observe_repository(cwd), config) for cwd in candidates if cwd]
        known = [x for x in observed if x['status'] == 'verified']
        if len({x['project_id'] for x in known}) > 1:
            raise CapturePolicyBlocked('routing_conflict')
        if any(x['project_id'] != identity['project_id'] for x in known):
            raise CapturePolicyBlocked('routing_conflict')
        if (None in candidates or any(x['status'] != 'verified' for x in observed)) and storage is None:
            raise CapturePolicyBlocked('routing_unverified')
        if known:
            storage = known[0]
    result = check_capture_routing(identity, storage, routed)
    if not result['allowed']:
        raise CapturePolicyBlocked(result['reason'])
    return destination


def _source_context(source_id, revision, cwds, paths, destination, source_store, config, destination_cwds=None, allow_unknown_single_source=False):
    observations = [observe_repository(cwd) for cwd in cwds]
    identities = [resolve_project_identity(o, config) for o in observations]
    identity = identities[0] if identities else resolve_project_identity(None, config)
    if any(x['reason'] in ('invalid_config', 'ambiguous_config', 'invalid_remote', 'ambiguous_repository') for x in identities or [identity]):
        raise CapturePolicyBlocked('identity_invalid')
    known = [x for x in identities if x['status'] == 'verified']
    if len({(x['project_id'], x['worktree_id']) for x in known}) > 1:
        raise CapturePolicyBlocked('source_identity_ambiguous')
    if destination_cwds is None:
        qualify_capture_route(source_store, destination, observations[0] if observations else None, identity, config)
    else:
        # Native persona/project stores use truncated legacy slugs. Check every
        # native session mapped to that partition before accepting new output.
        candidates = list(destination_cwds() if callable(destination_cwds) else destination_cwds)
        if not candidates or len(candidates) > 4096:
            raise CapturePolicyBlocked('routing_unverified')
        targets = [resolve_project_identity(observe_repository(cwd), config) if cwd else resolve_project_identity(None, config)
                   for cwd in set(candidates)]
        isolated_unknown = (allow_unknown_single_source and identity['status'] == 'unknown'
            and len(set(candidates)) == 1 and len(cwds) == 1
            and canonical_capture_path(candidates[0]) == canonical_capture_path(cwds[0]))
        if not isolated_unknown and (identity['status'] != 'verified' or any(x['status'] != 'verified' for x in targets)):
            raise CapturePolicyBlocked('routing_unverified')
        if not isolated_unknown and any(x['project_id'] != identity['project_id'] for x in targets):
            raise CapturePolicyBlocked('routing_conflict')
    paths = {*paths, canonical_capture_path(str(destination))}
    if len(paths) > 4096:
        raise CapturePolicyBlocked('source_metadata_limit')
    return ({'source_id': source_id, 'revision': revision,
             'project_id': identity['project_id'], 'worktree_id': identity['worktree_id'],
             'paths': sorted(paths), 'complete': bool(identities) and all(x['status'] == 'verified' for x in identities),
             'identity_fingerprint': identity['config_fingerprint']}, identity)


@dataclass(frozen=True)
class BoundCapture:
    snapshot: Path | None
    memory_dir: Path
    source: dict
    identity: dict
    projection: object = None
    turn_index: object = None


@contextmanager
def bound_file_capture(path, runtime, session_id, memory_dir, source_store=None, projector=None, destination_cwds=None, bind_turns=False):
    """Projectors consume one bounded record stream; extraction receives it only after validation.

    Legacy path-only parsers use a private snapshot up to 64 MiB. Streaming
    projectors accept sources up to 2 GiB without retaining raw tool payloads.
    Neither path dispatches a request, acknowledges a cursor or moves a store.
    """
    path = Path(path)
    policy = read_capture_policy()
    if policy['state'] == 'invalid':
        raise CapturePolicyBlocked('invalid_policy')
    source_id = session_id if session_id.startswith(runtime + ':') else runtime + ':' + session_id
    turns = JsonlTurnIndex(runtime, session_id) if bind_turns else None
    if policy.get('policy'):
        p = policy['policy']; physical = canonical_capture_path(str(path))
        if source_id in p['exclude_sources']:
            raise CapturePolicyBlocked('source_excluded')
        if any(root == '/' or physical == root or physical.startswith(root + '/') for root in p['exclude_paths']):
            raise CapturePolicyBlocked('path_excluded')
    config = _identity_config()
    payload = bytearray() if projector is None else None
    hasher = hashlib.sha256(); total = 0; cwds = []; paths = {canonical_capture_path(str(path))}
    preview = {}; native_sessions = set(); openclaw_ids = set(); openclaw_seen = False
    if runtime == 'openclaw':
        native_sessions.update('openclaw:' + name for name in {path.stem, path.stem.removesuffix('.trajectory')})
        if native_sessions.intersection(policy.get('policy', {}).get('exclude_sources', [])):
            raise CapturePolicyBlocked('source_excluded')
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(fd)
        limit = MAX_SOURCE_BYTES if projector else MAX_RAW_SNAPSHOT_BYTES
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise CapturePolicyBlocked('source_size_limit')
        with os.fdopen(fd, 'rb') as fh:
            fd = None

            def records():
                nonlocal total, openclaw_seen
                for index in range(MAX_RECORDS + 1):
                    line = fh.readline(MAX_RECORD_BYTES + 1)
                    if not line:
                        break
                    if index == MAX_RECORDS or len(line) > MAX_RECORD_BYTES or total + len(line) > limit:
                        raise CapturePolicyBlocked('source_size_limit')
                    total += len(line); hasher.update(line)
                    if payload is not None:
                        payload.extend(line)
                    if not line.strip():
                        continue
                    try:
                        record = json.loads(line.decode('utf8', errors='strict'))
                    except (ValueError, UnicodeError):
                        raise CapturePolicyBlocked('source_metadata_invalid') from None
                    if not isinstance(record, dict):
                        raise CapturePolicyBlocked('source_metadata_invalid')
                    if runtime == 'codex' and (record.get('type') == 'session' and isinstance(record.get('id'), str)
                            or isinstance(record.get('workspaceDir'), str)
                            and any(isinstance(record.get(key), str) for key in ('sessionId', 'sessionKey'))):
                        raise CapturePolicyBlocked('source_runtime_ambiguous')
                    if runtime == 'openclaw':
                        if record.get('type') == 'session_meta' and isinstance(record.get('payload'), dict):
                            raise CapturePolicyBlocked('source_runtime_mismatch')
                        openclaw_seen |= (record.get('type') == 'session' and isinstance(record.get('id'), str)
                            or isinstance(record.get('workspaceDir'), str)
                            and any(isinstance(record.get(key), str) for key in ('sessionId', 'sessionKey')))
                        identities = [record.get('sessionId')]
                        if record.get('type') == 'session':
                            identities.append(record.get('id'))
                        for value in [*identities, record.get('sessionKey')]:
                            if value is None:
                                continue
                            if (not isinstance(value, str) or not value or value == 'openclaw:'
                                    or len(value.encode()) > 480 or re.search(r'[\x00-\x1f\x7f]', value)):
                                raise CapturePolicyBlocked('source_metadata_invalid')
                            native_sessions.add(value if value.startswith('openclaw:') else 'openclaw:' + value)
                        openclaw_ids.update(value.removeprefix('openclaw:') for value in identities if value is not None)
                        if len(openclaw_ids) > 1:
                            raise CapturePolicyBlocked('source_session_ambiguous')
                        if len(native_sessions) > 32:
                            raise CapturePolicyBlocked('source_metadata_limit')
                        if native_sessions.intersection(policy.get('policy', {}).get('exclude_sources', [])):
                            raise CapturePolicyBlocked('source_excluded')
                    if runtime == 'codex' and record.get('type') == 'session_meta' and isinstance(record.get('payload'), dict):
                        native_id = record['payload'].get('id', record['payload'].get('session_id'))
                        if native_id is not None:
                            if not isinstance(native_id, str) or not native_id or len(native_id.encode()) > 480 or any(ord(c) < 32 for c in native_id):
                                raise CapturePolicyBlocked('source_metadata_invalid')
                            native_sessions.add(native_id if native_id.startswith('codex:') else 'codex:' + native_id)
                            if len(native_sessions) > 1:
                                raise CapturePolicyBlocked('source_session_ambiguous')
                            if native_sessions.intersection(policy.get('policy', {}).get('exclude_sources', [])):
                                raise CapturePolicyBlocked('source_excluded')
                    cwd = _native_cwd(record)
                    if cwd:
                        if not valid_capture_path(cwd):
                            raise CapturePolicyBlocked('source_metadata_invalid')
                        if cwd not in cwds:
                            cwds.append(cwd)
                        paths.add(canonical_capture_path(cwd))
                    paths.update(_structured_paths(record, cwds[-1] if cwds else None))
                    if runtime == 'openclaw':
                        paths.update(_openclaw_structured_paths(record, cwds[-1] if cwds else None))
                    if len(cwds) > 32 or len(paths) > 4096:
                        raise CapturePolicyBlocked('source_metadata_limit')
                    # Before a pure projector sees a known private source, enforce
                    # its native project/path metadata. No payload is persisted.
                    if policy['state'] == 'valid' and cwds:
                        from capture_policy import capture_decision
                        if cwds[-1] not in preview:
                            preview[cwds[-1]] = resolve_project_identity(observe_repository(cwds[-1]), config)
                        ident = preview[cwds[-1]]
                        provisional = {'source_id': source_id, 'revision': '0' * 64,
                            'project_id': ident['project_id'], 'worktree_id': ident['worktree_id'],
                            'paths': sorted(paths), 'complete': ident['status'] == 'verified'}
                        if runtime == 'openclaw':
                            provisional['binding_revision'] = OPENCLAW_BINDING_REVISION
                        decision = capture_decision(policy, provisional)
                        if not decision['allowed']:
                            raise CapturePolicyBlocked(decision['reason'])
                    if turns is not None:
                        turns.add_record(record, index + 1, line)
                    yield record

            iterator = records()
            projection = projector(iterator) if projector else None
            for _ in iterator:
                pass
            if runtime == 'openclaw' and not openclaw_seen:
                raise CapturePolicyBlocked('source_runtime_unverified')
            after = os.fstat(fh.fileno())
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise CapturePolicyBlocked('source_changed')
    except OSError:
        raise CapturePolicyBlocked('source_unavailable') from None
    finally:
        if fd is not None:
            os.close(fd)
    primary_cwd = cwds[0] if cwds else ''
    if callable(memory_dir):
        memory_dir = memory_dir(primary_cwd)
    if callable(source_store):
        source_store = source_store(primary_cwd)
    if memory_dir is None:
        raise CapturePolicyBlocked('source_project_excluded')
    if source_store and Path(source_store).name.startswith('-') and primary_cwd and encode_project_directory(primary_cwd) != Path(source_store).name:
        raise CapturePolicyBlocked('source_directory_mismatch')
    source, identity = _source_context(source_id, hasher.hexdigest(), cwds, paths, destination=memory_dir,
                                       source_store=source_store or path.parent, config=config,
                                       destination_cwds=destination_cwds)
    if runtime == 'openclaw':
        source['binding_revision'] = OPENCLAW_BINDING_REVISION
    destination = Path(memory_dir)
    sources = [source, *[{**source, 'source_id': alias} for alias in sorted(native_sessions) if alias != source_id]]
    require_capture_allowed(sources)
    if turns is not None:
        turn_projection = projection[1] if isinstance(projection, tuple) and len(projection) == 3 else projection
        turns.seal(source, turn_projection)
    with capture_scope(sources), source_turn_scope(turns):
        if projector:
            yield BoundCapture(None, destination, source, identity, projection, turns)
        else:
            with tempfile.TemporaryDirectory(prefix='engram-capture-') as temp:
                snapshot = Path(temp)/path.name
                out = os.open(snapshot, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(out, 'wb') as fh:
                    fh.write(payload)
                yield BoundCapture(snapshot, destination, source, identity, turn_index=turns)


@contextmanager
def bound_file_archive(path, runtime, destination):
    """Bind a native source to its physical archive path, without memory routing.

    The archive retains one file's bytes under its existing logical name. It
    selects no shared memory partition. Consume metadata before creating a copy.
    """
    if runtime not in ('claude-code', 'codex', 'openclaw'):
        raise CapturePolicyBlocked('source_runtime_unsupported')
    path = Path(path)
    cwds, aliases = [], set()
    session_id = path.stem.removesuffix('.trajectory') if runtime == 'openclaw' else path.stem
    def metadata(records):
        for record in records:
            cwd = _native_cwd(record)
            if cwd and cwd not in cwds:
                cwds.append(cwd)
            if runtime == 'claude-code':
                values = [record.get('sessionId')]
                if record.get('isSidechain') is True:
                    values.append(record.get('agentId'))
                for value in values:
                    if value is not None:
                        if (not isinstance(value, str) or not value or len(value) > 480
                                or re.search(r'[\x00-\x1f\x7f]', value)):
                            raise CapturePolicyBlocked('source_metadata_invalid')
                        aliases.add(value if value.startswith(runtime + ':') else runtime + ':' + value)
                if len(aliases) > 32:
                    raise CapturePolicyBlocked('source_metadata_limit')

    with bound_file_capture(path, runtime, session_id, destination, path.parent,
                            projector=metadata, destination_cwds=lambda: cwds) as bound:
        sources = current_capture_sources()
        known = {source['source_id'] for source in sources}
        sources.extend({**bound.source, 'source_id': alias} for alias in sorted(aliases - known))
        with capture_scope(sources):
            yield bound


@contextmanager
def bound_hermes_capture(db, session_id, memory_dir, projector, destination_cwds=None):
    """Read native metadata and messages from one SQLite snapshot, with no DB writes.

    The revision covers the selected session row and every message row, including
    inactive/tool rows. Only the caller's bounded conversation projection survives.
    """
    source_id = 'hermes:' + session_id
    policy = read_capture_policy()
    if policy['state'] == 'invalid':
        raise CapturePolicyBlocked('invalid_policy')
    if source_id in policy.get('policy', {}).get('exclude_sources', []):
        raise CapturePolicyBlocked('source_excluded')
    config = _identity_config()
    files = db.execute('PRAGMA database_list').fetchall()
    physical = next((canonical_capture_path(row[2]) for row in files if row[1] == 'main' and row[2]), None)
    p = policy.get('policy', {})
    if p and (p['default'] == 'deny' or p['projects'] or p['exclude_paths'] or p['exclude_sources']):
        if physical is None:
            raise CapturePolicyBlocked('source_unavailable')
        from hermes_capture import bound_hermes_snapshot
        # Close both passive snapshots before the caller can dispatch a provider.
        with bound_hermes_snapshot(physical, session_id, memory_dir, projector, destination_cwds) as bound:
            sources = current_capture_sources()
            result = BoundCapture(None, bound.memory_dir, bound.source, bound.identity, bound.projection, bound.turn_index)
            turns = bound.turn_index
        with capture_scope(sources), source_turn_scope(turns):
            yield result
        return
    paths = {physical} if physical else set()
    db.execute('SAVEPOINT engram_capture_source')
    try:
        cursor = db.execute('SELECT * FROM sessions WHERE id=?', (session_id,))
        row = cursor.fetchone()
        if row is None:
            raise CapturePolicyBlocked('source_unavailable')
        metadata = dict(zip([x[0] for x in cursor.description], row))
        cwd = _native_cwd(metadata)
        if cwd and not valid_capture_path(cwd):
            raise CapturePolicyBlocked('source_metadata_invalid')
        cwds = [cwd] if cwd else []
        destination = memory_dir(cwd or '') if callable(memory_dir) else memory_dir
        if destination is None:
            raise CapturePolicyBlocked('source_project_excluded')
        if cwd:
            paths.add(canonical_capture_path(cwd))
        # Resolve and check before retrieving message content. Routing candidates
        # are metadata from this same transaction when supplied as a callable.
        source, identity = _source_context(source_id, '0' * 64, cwds, paths, destination,
            Path(destination).parent, config, destination_cwds)
        require_capture_allowed([source])
        hasher = hashlib.sha256()
        total = 0
        turns = HermesTurnIndex(session_id)

        def revision_record(value):
            nonlocal total
            try:
                raw = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf8') + b'\n'
            except (TypeError, UnicodeError):
                raise CapturePolicyBlocked('source_metadata_invalid') from None
            if len(raw) > MAX_RECORD_BYTES or total + len(raw) > MAX_SOURCE_BYTES:
                raise CapturePolicyBlocked('source_size_limit')
            total += len(raw); hasher.update(raw)

        revision_record({'session': metadata})
        cursor = db.execute('SELECT * FROM messages WHERE session_id=? ORDER BY timestamp, id', (session_id,))
        columns = [x[0] for x in cursor.description]

        def records():
            for index, row in enumerate(cursor):
                if index >= MAX_RECORDS:
                    raise CapturePolicyBlocked('source_size_limit')
                message = dict(zip(columns, row))
                revision_record({'message': message})
                turns.add(message)
                calls = message.get('tool_calls') or []
                if isinstance(calls, str):
                    try:
                        calls = json.loads(calls)
                    except ValueError:
                        raise CapturePolicyBlocked('source_metadata_invalid') from None
                blocks = []
                for call in calls if isinstance(calls, list) else []:
                    if isinstance(call, dict):
                        fn = call.get('function', call)
                        if isinstance(fn, dict):
                            blocks.append(fn)
                paths.update(_structured_paths({'message': {'content': blocks}}, cwd))
                if len(paths) > 4096:
                    raise CapturePolicyBlocked('source_metadata_limit')
                provisional = {**source, 'paths': sorted(set(source['paths']) | paths)}
                require_capture_allowed([provisional])
                yield message

        iterator = records()
        projection = projector(iterator)
        for _ in iterator:
            pass
        source = {**source, 'revision': hasher.hexdigest(), 'paths': sorted(set(source['paths']) | paths)}
        turns.seal(source, projection)
    finally:
        db.execute('RELEASE SAVEPOINT engram_capture_source')
    # Do not hold a read transaction open during a provider request.
    with capture_scope([source]), source_turn_scope(turns):
        yield BoundCapture(None, Path(destination), source, identity, projection, turns)


@contextmanager
def bound_document_capture(path, destination, destination_cwds):
    """Bind a primary Markdown document without claiming generated-memory support."""
    path = Path(path); destination = Path(destination)
    config = _identity_config()
    physical = canonical_capture_path(str(path))
    source_id = 'context-file:' + hashlib.sha256(physical.encode()).hexdigest()
    source, identity = _source_context(source_id, '0' * 64, [str(path.parent.resolve())], {physical},
        destination, path.parent, config, destination_cwds, allow_unknown_single_source=True)
    require_capture_allowed([source])
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_RAW_SNAPSHOT_BYTES:
            raise CapturePolicyBlocked('source_size_limit')
        with os.fdopen(fd, 'rb') as fh:
            fd = None
            data = fh.read(MAX_RAW_SNAPSHOT_BYTES + 1)
            after = os.fstat(fh.fileno())
        if len(data) > MAX_RAW_SNAPSHOT_BYTES:
            raise CapturePolicyBlocked('source_size_limit')
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise CapturePolicyBlocked('source_changed')
        text = data.decode('utf8', errors='strict')
    except (OSError, UnicodeError):
        raise CapturePolicyBlocked('source_unavailable') from None
    finally:
        if fd is not None:
            os.close(fd)
    source['revision'] = hashlib.sha256(data).hexdigest()
    with capture_scope([source]):
        yield BoundCapture(None, destination, source, identity, text)
