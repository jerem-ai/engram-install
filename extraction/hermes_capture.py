"""Source-bound Hermes conversation snapshots. No extraction cursor is advanced."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path

from capture_binding import (_identity_config, _native_cwd, _openclaw_structured_paths,
                             _source_context, MAX_RAW_SNAPSHOT_BYTES)
from capture_policy import (CapturePolicyBlocked, HERMES_BINDING_REVISION, canonical_capture_path,
                            capture_path_allowed, capture_scope, read_capture_policy, require_capture_allowed,
                            valid_capture_path)
from hermes_snapshot import RawText, hermes_snapshot, text
from project_identity import observe_repository, resolve_project_identity
from source_turns import HermesTurnIndex


@dataclass
class HermesCapture:
    source: dict
    identity: dict
    memory_dir: Path
    projection: object
    stream: object
    current: object
    turn_index: object = None


def _native_text(row):
    out = {}
    for key, value in row.items():
        if isinstance(value, RawText):
            try:
                value = value.decode('utf8', errors='strict')
            except UnicodeError:
                if key in ('role', 'content', 'tool_name'):
                    raise CapturePolicyBlocked('source_metadata_invalid') from None
        if key in ('role', 'content', 'tool_name') and value is not None and not isinstance(value, str):
            raise CapturePolicyBlocked('source_metadata_invalid')
        out[key] = value
    return out


def _message_paths(message, cwd):
    if message.get('type') in ('toolCall', 'tool_use', 'function_call'):
        message = {'content': [message]}
    return _openclaw_structured_paths({'type': 'context.compiled', 'data': {'messages': [message]}}, cwd)


@contextmanager
def bound_hermes_snapshot(path, session_id, destination, projector=None, destination_cwds=None):
    """Resolve native identities, inspect every dependency, then expose one source stream."""
    path = Path(path).absolute()
    policy = read_capture_policy()
    if policy['state'] == 'invalid':
        raise CapturePolicyBlocked('invalid_policy')
    physical = canonical_capture_path(str(path))
    response = path.with_name('response_store.db')
    databases = [path, *([response] if response.exists() else [])]
    files = {canonical_capture_path(str(db) + suffix) for db in databases
             for suffix in ('', '-wal', '-shm', '-journal')}
    if (not all(capture_path_allowed(policy, item) for item in files)
            or 'hermes:' + session_id in policy.get('policy', {}).get('exclude_sources', [])):
        raise CapturePolicyBlocked('source_excluded')
    config = _identity_config()
    sources, identities, cwds = {}, {}, {}
    selected_destination = None

    def authorize(metadata):
        nonlocal selected_destination
        sid = metadata['id']; cwd = _native_cwd(metadata)
        if not cwd or not valid_capture_path(cwd):
            raise CapturePolicyBlocked('routing_unverified')
        target = destination(cwd) if callable(destination) else destination
        if target is None:
            raise CapturePolicyBlocked('source_project_excluded')
        target = Path(target)
        candidates = destination_cwds if sid == session_id and destination_cwds is not None else [cwd]
        source, identity = _source_context('hermes:' + sid, '0' * 64, [cwd], files | {canonical_capture_path(cwd)},
            target, path.parent, config, candidates)
        source['binding_revision'] = HERMES_BINDING_REVISION
        require_capture_allowed([source])
        sources[sid], identities[sid], cwds[sid] = source, identity, cwd
        if sid == session_id:
            selected_destination = target

    with hermes_snapshot(path, session_id, authorize) as snapshot:
        projected = []; projection_bytes = 0
        turns = HermesTurnIndex(session_id) if projector is not None else None
        def check():
            snapshot.current()
            require_capture_allowed(list(sources.values()))
            if _identity_config() != config:
                raise CapturePolicyBlocked('identity_changed')
            for sid, cwd in cwds.items():
                if resolve_project_identity(observe_repository(cwd), config) != identities[sid]:
                    raise CapturePolicyBlocked('identity_changed')

        def inspect(database, table, raw):
            nonlocal projection_bytes
            require_capture_allowed(list(sources.values()))
            paths = set(); owner = None
            if database == 'state' and table == 'messages':
                owner = text(raw['session_id']); message = {}
                calls = raw.get('tool_calls')
                if calls:
                    try: message['tool_calls'] = json.loads(text(calls))
                    except (ValueError, TypeError): raise CapturePolicyBlocked('source_metadata_invalid') from None
                paths.update(_message_paths(message, cwds[owner]))
                for field in ['api_content', 'codex_message_items']:
                    value = raw.get(field)
                    if value:
                        value = text(value)
                        if value.lstrip().startswith(('{', '[')):
                            try: parsed = json.loads(value)
                            except ValueError: raise CapturePolicyBlocked('source_metadata_invalid') from None
                            for message in parsed if isinstance(parsed, list) else [parsed]:
                                if isinstance(message, dict):
                                    paths.update(_message_paths(message, cwds[owner]))
                if projector is not None and owner == session_id:
                    projection_bytes += sum(len(value) if isinstance(value, (str, bytes)) else 16 for value in raw.values())
                    if projection_bytes > MAX_RAW_SNAPSHOT_BYTES:
                        raise CapturePolicyBlocked('source_projection_limit')
                    projected.append(_native_text(raw))
                    turns.add(raw)
            elif database == 'responses' and table == 'responses':
                try: data = json.loads(text(raw['data']))
                except (ValueError, TypeError): raise CapturePolicyBlocked('source_metadata_invalid') from None
                if not isinstance(data, dict) or not isinstance(data.get('response'), dict):
                    raise CapturePolicyBlocked('source_metadata_invalid')
                history = data.get('conversation_history', [])
                output = data['response'].get('output', [])
                if not isinstance(history, list) or not isinstance(output, list):
                    raise CapturePolicyBlocked('source_metadata_invalid')
                for message in [*history, *output]:
                    if isinstance(message, dict):
                        for cwd in cwds.values(): paths.update(_message_paths(message, cwd))
            if paths:
                targets = [owner] if owner else sources.keys()
                for sid in targets:
                    sources[sid]['paths'] = sorted(set(sources[sid]['paths']) | paths)
                    if len(sources[sid]['paths']) > 4096:
                        raise CapturePolicyBlocked('source_metadata_limit')
            require_capture_allowed(list(sources.values()))

        digest = hashlib.sha256()
        for block in snapshot.encoded(inspect):
            digest.update(block)
        revision = digest.hexdigest()
        for source in sources.values(): source['revision'] = revision
        check()
        projection = projector(iter(projected)) if projector is not None else None
        projected.clear()
        if turns is not None:
            turns.seal(sources[session_id], projection)
        # Repeat the same frozen rows without retaining the raw source in memory.
        def stream():
            check()
            for block in snapshot.encoded(lambda *_: require_capture_allowed(list(sources.values()))):
                require_capture_allowed(list(sources.values()))
                yield block
            check()
        with capture_scope(list(sources.values())):
            yield HermesCapture(sources[session_id], identities[session_id], selected_destination, projection, stream, check, turns)
            check()
