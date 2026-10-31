"""Capture consent/eligibility shared with the runtime. This grants no tool authority."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps

from install_config import read_engram_env

SCHEMA = 'engram.capture-policy.v1'
MAX_CAPTURE_POLICY_BYTES = 64 * 1024
MAX_ARTIFACT_CAPTURE_SOURCES = 4096
PROJECT = re.compile(r'project:[a-f0-9]{64}\Z')
WORKTREE = re.compile(r'worktree:[a-f0-9]{64}\Z')
SHA = re.compile(r'[a-f0-9]{64}\Z')


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def _token(value):
    return isinstance(value, str) and _utf8_length(value) in range(1, 513) and not re.search(r'[\x00-\x1f\x7f]', value)


def _utf8_length(value):
    try:
        return len(value.encode('utf8'))
    except UnicodeError:
        return -1


def valid_capture_path(value):
    return (isinstance(value, str) and 0 <= _utf8_length(value) <= 4096 and value.startswith('/')
            and not re.search(r'[\x00-\x1f\x7f\\]', value)
            and (value == '/' or (not value.endswith('/') and '//' not in value
                                 and not any(x in ('.', '..') for x in value.split('/')))))


def canonical_capture_path(value):
    return str(Path(value).resolve())


def capture_path_allowed(snapshot, source_path):
    if snapshot['state'] == 'legacy':
        return True
    if snapshot['state'] != 'valid':
        return False
    try:
        physical = canonical_capture_path(str(source_path))
        return not any(root == '/' or physical == root or physical.startswith(root + '/') for root in snapshot['policy']['exclude_paths'])
    except (OSError, RuntimeError):
        return False


def capture_policy_snapshot(value):
    invalid = {'state': 'invalid', 'fingerprint': _digest('invalid')}
    if (not isinstance(value, dict) or set(value) - {'schema', 'default', 'projects', 'exclude_paths', 'exclude_sources'}
            or value.get('schema') != SCHEMA or value.get('default') not in ('allow', 'deny')):
        return invalid
    projects, paths, sources = value.get('projects', {}), value.get('exclude_paths', []), value.get('exclude_sources', [])
    if (not isinstance(projects, dict) or len(projects) > 10000
            or any(not isinstance(k, str) or not PROJECT.fullmatch(k) or v not in ('allow', 'deny') for k, v in projects.items())
            or not isinstance(paths, list) or len(paths) > 10000 or not all(valid_capture_path(x) for x in paths)
            or not isinstance(sources, list) or len(sources) > 10000 or not all(_token(x) for x in sources)):
        return invalid
    policy = {'schema': SCHEMA, 'default': value['default'], 'projects': projects,
              'exclude_paths': paths, 'exclude_sources': sources}
    return {'state': 'valid', 'fingerprint': _digest(policy), 'policy': policy}


LEGACY_CAPTURE_POLICY = {'state': 'legacy', 'fingerprint': _digest('legacy')}
_SOURCES = ContextVar('engram_capture_sources', default=None)


class CapturePolicyBlocked(RuntimeError):
    """Contains a fixed reason only. Never attach source paths, IDs or bodies."""
    def __init__(self, reason='source_context_unknown'):
        self.reason = reason
        super().__init__('capture blocked: ' + reason)


def require_capture_allowed(sources=None):
    snapshot = read_capture_policy()
    sources = _SOURCES.get() if sources is None else sources
    if not isinstance(sources, (list, tuple)) or not sources:
        decision = capture_decision(snapshot, None)
        if not decision['allowed']:
            raise CapturePolicyBlocked(decision['reason'])
    else:
        for source in sources:
            decision = capture_decision(snapshot, source)
            if not decision['allowed']:
                raise CapturePolicyBlocked(decision['reason'])
    return snapshot['fingerprint']


@contextmanager
def capture_scope(sources):
    if not isinstance(sources, (list, tuple)) or not 0 < len(sources) <= 1024 or not all(capture_source_valid(x) for x in sources):
        raise CapturePolicyBlocked('source_context_unknown')
    sources = json.loads(json.dumps(sources))
    if len(json.dumps(sources, ensure_ascii=False).encode()) > 1024 * 1024:
        raise CapturePolicyBlocked('dependency_manifest_limit')
    require_capture_allowed(sources)
    scope_marker = _SOURCES.set(sources)
    try:
        yield
    finally:
        _SOURCES.reset(scope_marker)


def current_capture_sources():
    value = _SOURCES.get()
    return json.loads(json.dumps(value)) if value is not None else None


def include_capture_dependencies(sources):
    current = _SOURCES.get()
    if current is None:
        return
    merged = {json.dumps(x, sort_keys=True): x for x in [*current, *sources]}
    values = list(merged.values())
    if len(values) > 1024 or len(json.dumps(values, ensure_ascii=False).encode()) > 1024 * 1024:
        raise CapturePolicyBlocked('dependency_manifest_limit')
    if not all(capture_source_valid(x) for x in values):
        raise CapturePolicyBlocked('source_context_unknown')
    require_capture_allowed(values)
    _SOURCES.set(json.loads(json.dumps(values)))


def include_capture_paths(paths):
    """Bind output/read paths before a scoped operation creates any file."""
    paths = [canonical_capture_path(str(path)) for path in paths]
    if not all(valid_capture_path(path) for path in paths):
        raise CapturePolicyBlocked('source_metadata_invalid')
    current = _SOURCES.get()
    if current is None:
        require_capture_allowed()
        return
    values = [{**source, 'paths': sorted(set(source['paths']) | set(paths))} for source in current]
    if not all(capture_source_valid(source) for source in values):
        raise CapturePolicyBlocked('source_metadata_limit')
    if len(json.dumps(values, ensure_ascii=False).encode()) > 1024 * 1024:
        raise CapturePolicyBlocked('dependency_manifest_limit')
    require_capture_allowed(values)
    _SOURCES.set(values)


def checked_capture_call(fn):
    """Recheck before dispatch and before returning or exposing an error body."""
    @wraps(fn)
    def checked(*args, **kwargs):
        require_capture_allowed()
        try:
            return fn(*args, **kwargs)
        finally:
            require_capture_allowed()
    return checked


def capture_policy_path():
    return Path(os.environ.get('ENGRAM_CAPTURE_POLICY') or read_engram_env().get('ENGRAM_CAPTURE_POLICY')
                or Path.home()/'.config/engram/capture-policy.json')


def read_capture_policy(file=None):
    fd = None
    configured = os.environ.get('ENGRAM_CAPTURE_POLICY') or read_engram_env().get('ENGRAM_CAPTURE_POLICY')
    required = file is not None or bool(configured)
    try:
        fd = os.open(file or configured or Path.home()/'.config/engram/capture-policy.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CAPTURE_POLICY_BYTES or info.st_uid != os.getuid() or info.st_mode & 0o022:
            return capture_policy_snapshot(None)
        data = bytearray()
        while len(data) <= MAX_CAPTURE_POLICY_BYTES:
            chunk = os.read(fd, MAX_CAPTURE_POLICY_BYTES + 1 - len(data))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > MAX_CAPTURE_POLICY_BYTES:
            return capture_policy_snapshot(None)
        result = capture_policy_snapshot(json.loads(data.decode('utf8', errors='strict')))
        if 'policy' in result:
            result['policy']['exclude_paths'] = [canonical_capture_path(x) for x in result['policy']['exclude_paths']]
            result['fingerprint'] = _digest(result['policy'])
        return result
    except FileNotFoundError:
        return capture_policy_snapshot(None) if required else LEGACY_CAPTURE_POLICY
    except (OSError, ValueError, TypeError, RuntimeError):
        return capture_policy_snapshot(None)
    finally:
        if fd is not None:
            os.close(fd)


OPENCLAW_BINDING_REVISION = 5
HERMES_BINDING_REVISION = 1


def capture_source_valid(source):
    return (isinstance(source, dict)
            and not set(source) - {'source_id', 'revision', 'project_id', 'worktree_id', 'paths', 'complete', 'identity_fingerprint', 'binding_revision'}
            and _token(source.get('source_id')) and isinstance(source.get('revision'), str) and bool(SHA.fullmatch(source['revision']))
            and (source.get('project_id') is None or (isinstance(source['project_id'], str) and bool(PROJECT.fullmatch(source['project_id']))))
            and (source.get('worktree_id') is None or (isinstance(source['worktree_id'], str) and bool(WORKTREE.fullmatch(source['worktree_id']))))
            and 'project_id' in source and 'worktree_id' in source
            and isinstance(source.get('paths'), list) and 0 < len(source['paths']) <= 4096
            and all(valid_capture_path(x) for x in source['paths']) and isinstance(source.get('complete'), bool)
            and ('identity_fingerprint' not in source or (isinstance(source['identity_fingerprint'], str) and bool(SHA.fullmatch(source['identity_fingerprint']))))
            and ('binding_revision' not in source or (type(source['binding_revision']) in (int, float)
                 and 0 < source['binding_revision'] <= 9007199254740991
                 and int(source['binding_revision']) == source['binding_revision'])))


def capture_decision(snapshot, source):
    def result(allowed, reason):
        return {'allowed': allowed, 'reason': reason, 'policy_fingerprint': snapshot['fingerprint']}
    if snapshot['state'] == 'legacy':
        return result(True, 'legacy')
    if snapshot['state'] != 'valid' or 'policy' not in snapshot:
        return result(False, 'invalid_policy')
    p = snapshot['policy']
    restricted = p['default'] == 'deny' or bool(p['projects'] or p['exclude_paths'] or p['exclude_sources'])
    if not capture_source_valid(source):
        return result(not restricted, 'source_context_unknown' if restricted else 'unrestricted')
    if source['source_id'] in p['exclude_sources']:
        return result(False, 'source_excluded')
    if any(root == '/' or path == root or path.startswith(root + '/') for path in source['paths'] for root in p['exclude_paths']):
        return result(False, 'path_excluded')
    if not source['complete'] and restricted:
        return result(False, 'source_context_unknown')
    if restricted and source['source_id'].startswith('openclaw:') and source.get('binding_revision', 0) < OPENCLAW_BINDING_REVISION:
        return result(False, 'source_binding_outdated')
    if restricted and source['source_id'].startswith('hermes:') and source.get('binding_revision', 0) < HERMES_BINDING_REVISION:
        return result(False, 'source_binding_outdated')
    if not source['project_id'] and (p['default'] == 'deny' or p['projects']):
        return result(False, 'project_unknown')
    selected = p['projects'].get(source['project_id'], p['default']) if source['project_id'] else p['default']
    return result(selected == 'allow', 'allowed' if selected == 'allow' else 'project_excluded')


def capture_sources_allowed(snapshot, sources):
    if snapshot['state'] == 'legacy':
        return True
    if not isinstance(sources, list) or not sources or len(sources) > MAX_ARTIFACT_CAPTURE_SOURCES:
        return capture_decision(snapshot, None)['allowed']
    return all(capture_source_valid(x) and capture_decision(snapshot, x)['allowed'] for x in sources)


def capture_artifact_allowed(snapshot, frontmatter):
    if snapshot['state'] == 'legacy':
        return True
    if not isinstance(frontmatter, dict):
        return capture_decision(snapshot, None)['allowed']
    metadata = frontmatter.get('metadata') if isinstance(frontmatter.get('metadata'), dict) else {}
    if metadata.get('capture_incomplete') is True or frontmatter.get('capture_incomplete') is True:
        return capture_decision(snapshot, None)['allowed']
    return capture_sources_allowed(snapshot, metadata.get('capture_sources', frontmatter.get('capture_sources')))


def union_capture_metadata(frontmatters, paths=(), component_paths=None):
    """Retain every used component without a quadratic path manifest."""
    sources = {}
    incomplete = False
    components = list(component_paths) if component_paths is not None else [None] * len(frontmatters)
    if len(components) != len(frontmatters):
        raise ValueError('component provenance length mismatch')
    for fm, path in zip(frontmatters, components):
        meta = fm.get('metadata') if isinstance(fm.get('metadata'), dict) else {}
        values = meta.get('capture_sources', fm.get('capture_sources'))
        if (not isinstance(values, list) or not values or len(values) > MAX_ARTIFACT_CAPTURE_SOURCES
                or not all(capture_source_valid(source) for source in values)):
            incomplete = True
            continue
        incomplete |= meta.get('capture_incomplete') is True or fm.get('capture_incomplete') is True
        for source in values:
            binding = {key: value for key, value in source.items() if key != 'paths'}
            key = json.dumps(binding, sort_keys=True)
            if key not in sources:
                sources[key] = (binding, set())
            sources[key][1].update(source['paths'])
            if path is not None:
                sources[key][1].add(canonical_capture_path(str(path)))
            incomplete |= not source['complete']
    extra = {canonical_capture_path(str(path)) for path in paths}
    values = [{**binding, 'paths': sorted(local_paths | extra)} for binding, local_paths in sources.values()]
    if (len(values) > MAX_ARTIFACT_CAPTURE_SOURCES or not all(capture_source_valid(source) for source in values)
            or len(json.dumps(values).encode()) > 8 * 1024 * 1024):
        values = []; incomplete = True
    return {'capture_sources': values, 'capture_incomplete': incomplete or not values,
            'capture_policy': read_capture_policy()['fingerprint']}


def require_unbound_capture_allowed(paths=()):
    """Whole-store copies and legacy reports cannot borrow one session's scope."""
    snapshot = read_capture_policy()
    if (not capture_decision(snapshot, None)['allowed']
            or any(not capture_path_allowed(snapshot, path) for path in paths)):
        raise CapturePolicyBlocked('source_context_unknown')
    return snapshot['fingerprint']


def defer_unbound_capture(fn):
    """A deferred legacy job leaves source records pending and coding usable."""
    @wraps(fn)
    def run(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except CapturePolicyBlocked:
            print('capture deferred: source_context_unknown')
            return 0
    return run


def checked_unbound_capture_call(fn):
    """Global legacy inputs cannot borrow a single session's capture scope."""
    @wraps(fn)
    def run(*args, **kwargs):
        require_unbound_capture_allowed()
        try:
            return fn(*args, **kwargs)
        finally:
            require_unbound_capture_allowed()
    return run


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['--check-unbound']:
        try:
            require_unbound_capture_allowed()
        except CapturePolicyBlocked:
            print('capture deferred: source_context_unknown')
            sys.exit(3)
        sys.exit(0)
    request = json.load(sys.stdin)
    snapshot = capture_policy_snapshot(request['policy']) if 'policy' in request else LEGACY_CAPTURE_POLICY
    print(json.dumps({'snapshot': snapshot, 'decision': capture_decision(snapshot, request.get('source')),
                      'artifact_allowed': capture_artifact_allowed(snapshot, request.get('artifact'))}))
