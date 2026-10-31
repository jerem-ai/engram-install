"""Lossless, bounded conversation records from read-only Hermes SQLite snapshots.

This format preserves SQLite storage classes. It contains conversation data and
does not restore runtime leases, admissions, job queues or action authority.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import stat
from urllib.parse import quote

from capture_policy import CapturePolicyBlocked

SCHEMA = 'engram.hermes-session.v1'
MAX_BYTES = 2 * 1024 * 1024 * 1024
MAX_RECORD_BYTES = 32 * 1024 * 1024
MAX_RECORDS = 1000000
MAX_SESSIONS = 512
MAX_RESPONSES = 4096
# Metadata is embedded in response JSON; cap returned text before Python loads it.
RESPONSE_METADATA = '''SELECT substr(response_id,1,481),
    CASE WHEN json_type(data,'$.session_id')='text' THEN substr(json_extract(data,'$.session_id'),1,481)
         ELSE json_extract(data,'$.session_id') END,
    CASE WHEN json_type(data,'$.response.previous_response_id')='text'
         THEN substr(json_extract(data,'$.response.previous_response_id'),1,481)
         ELSE json_extract(data,'$.response.previous_response_id') END FROM responses'''


class RawText(bytes):
    """Native SQLite TEXT bytes, including unusual non-UTF-8 stored text."""


def text(value, optional=False):
    if value is None and optional:
        return None
    try:
        return value.decode('utf8', errors='strict') if isinstance(value, RawText) else value if isinstance(value, str) else _invalid()
    except UnicodeError:
        raise CapturePolicyBlocked('source_metadata_invalid') from None


def _invalid():
    raise CapturePolicyBlocked('source_metadata_invalid')


def encode_cell(value):
    if value is None:
        return ['null']
    if isinstance(value, (str, RawText)):
        raw = value.encode('utf8') if isinstance(value, str) else bytes(value)
        try:
            return ['text', raw.decode('utf8', errors='strict')]
        except UnicodeError:
            return ['text64', base64.b64encode(raw).decode('ascii')]
    if isinstance(value, bytes):
        return ['blob', base64.b64encode(value).decode('ascii')]
    if type(value) is int and -(2 ** 63) <= value < 2 ** 63:
        return ['integer', str(value)]
    if type(value) is float and not math.isnan(value):
        return ['real', value.hex()]
    _invalid()


def decode_cell(cell):
    if not isinstance(cell, list):
        _invalid()
    if cell == ['null']:
        return None
    if len(cell) != 2 or not isinstance(cell[1], str):
        _invalid()
    kind, value = cell
    try:
        if kind == 'text':
            value.encode('utf8', errors='strict')
            return value
        if kind in ('blob', 'text64'):
            decoded = base64.b64decode(value, validate=True)
            return RawText(decoded) if kind == 'text64' else decoded
        if kind == 'integer':
            decoded = int(value)
            if str(decoded) == value and -(2 ** 63) <= decoded < 2 ** 63:
                return decoded
        if kind == 'real':
            decoded = float.fromhex(value)
            if not math.isnan(decoded) and decoded.hex() == value:
                return decoded
    except (ValueError, UnicodeError, OverflowError):
        pass
    _invalid()


def _identifier(value):
    return '"' + value.replace('"', '""') + '"'


def _file_identity(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise CapturePolicyBlocked('source_file_invalid')
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class ReadDatabase:
    def __init__(self, path):
        self.path = Path(path).absolute()
        before = _file_identity(self.path)
        self.journals = {}
        for suffix in ('-wal', '-shm', '-journal'):
            journal = Path(str(self.path) + suffix)
            if os.path.lexists(journal):
                info = _file_identity(journal)
                # The shared-memory index may change during another reader's visit.
                self.journals[suffix] = info[:2]
        uri = 'file:' + quote(str(self.path), safe='/') + '?mode=ro'
        self.reader = sqlite3.connect(uri, uri=True)
        self.observer = None
        try:
            self.observer = sqlite3.connect(uri, uri=True)
            for db in (self.reader, self.observer):
                db.execute('PRAGMA query_only=ON')
            self.reader.text_factory = RawText
            self.version = self.observer.execute('PRAGMA data_version').fetchone()[0]
            self.identity = _file_identity(self.path)
            if before != self.identity:
                raise CapturePolicyBlocked('source_changed')
            self.reader.execute('BEGIN')
            self.reader.execute('SELECT name FROM sqlite_schema LIMIT 1').fetchone()
            self.current()
        except BaseException:
            self.close()
            raise

    def current(self):
        if (_file_identity(self.path) != self.identity
                or self.observer.execute('PRAGMA data_version').fetchone()[0] != self.version):
            raise CapturePolicyBlocked('source_changed')
        for suffix in ('-wal', '-shm', '-journal'):
            journal = Path(str(self.path) + suffix)
            info = _file_identity(journal)[:2] if os.path.lexists(journal) else None
            if suffix in self.journals and info != self.journals[suffix]:
                raise CapturePolicyBlocked('source_changed')
            if info is not None:
                self.journals[suffix] = info

    def close(self):
        self.reader.close()
        if self.observer is not None:
            self.observer.close()

    def columns(self, table):
        return [{'name': text(row[1]), 'type': text(row[2]), 'pk': row[5]}
                for row in self.reader.execute('PRAGMA table_info(' + _identifier(table) + ')')]

    def rows(self, table, where='', args=(), order=''):
        columns = self.columns(table)
        width = '+'.join('COALESCE(length(CAST(' + _identifier(c['name']) + ' AS BLOB)),0)' for c in columns)
        maximum = self.reader.execute('SELECT MAX(' + width + ') FROM ' + _identifier(table) + where, args).fetchone()[0] or 0
        if maximum > MAX_RECORD_BYTES:
            raise CapturePolicyBlocked('source_size_limit')
        cursor = self.reader.execute('SELECT * FROM ' + _identifier(table) + where + order, args)
        names = [column[0] for column in cursor.description]
        for row in cursor:
            yield dict(zip(names, row))


class HermesSnapshot:
    """The caller checks routing/eligibility for metadata before any body is read."""
    def __init__(self, state, selected, authorize_session, response=None):
        self.state, self.response, self.selected = state, response, selected
        self.authorize_session = authorize_session
        self.sessions = {}
        self.responses = {}
        self.predecessors = {}
        self.schemas = {}
        self.visiting = set()
        for database, source, tables in [('state', state, ['sessions', 'messages', 'system_prompts', 'session_model_usage']),
                                        ('responses', response, ['responses', 'conversations'])]:
            if source is not None:
                for table in tables:
                    columns = source.columns(table)
                    if columns:
                        self.schemas[database + '.' + table] = columns
        if any(name not in self.schemas for name in ['state.sessions', 'state.messages']):
            raise CapturePolicyBlocked('hermes_schema_unqualified')
        for key, required in [('state.sessions', {'id', 'cwd'}), ('state.messages', {'id', 'session_id'})]:
            if not required <= {c['name'] for c in self.schemas[key]}:
                raise CapturePolicyBlocked('hermes_schema_unqualified')
        self._closure(selected)

    def current(self):
        self.state.current()
        if self.response is not None:
            self.response.current()

    def _session(self, session):
        if session in self.visiting:
            raise CapturePolicyBlocked('hermes_reference_invalid')
        if session in self.sessions:
            return
        if len(self.sessions) >= MAX_SESSIONS or not isinstance(session, str) or not 0 < len(session.encode('utf8')) <= 480:
            raise CapturePolicyBlocked('source_metadata_limit')
        names = {column['name'] for column in self.schemas['state.sessions']}
        selected = [name for name in ['id', 'cwd', 'parent_session_id', 'system_prompt_hash', 'source', 'profile', 'profile_name'] if name in names]
        width = '+'.join('COALESCE(length(CAST(' + _identifier(name) + ' AS BLOB)),0)' for name in selected)
        size = self.state.reader.execute('SELECT ' + width + ' FROM sessions WHERE id=?', (session,)).fetchone()
        if size is not None and size[0] > 65536:
            raise CapturePolicyBlocked('source_metadata_limit')
        cursor = self.state.reader.execute('SELECT ' + ','.join(_identifier(name) for name in selected) + ' FROM sessions WHERE id=?', (session,))
        row = cursor.fetchone()
        if row is None:
            raise CapturePolicyBlocked('hermes_reference_missing')
        metadata = {name: text(value, optional=True) for name, value in zip(selected, row)}
        self.authorize_session(metadata)
        self.sessions[session] = metadata
        parent = metadata.get('parent_session_id')
        if parent:
            self.visiting.add(session)
            try:
                self._session(parent)
            finally:
                self.visiting.remove(session)

    def _closure(self, selected):
        self._session(selected)
        if self.response is None:
            if any(row.get('source') == 'api_server' for row in self.sessions.values()):
                raise CapturePolicyBlocked('hermes_reference_missing')
            return
        if not {'responses.responses', 'responses.conversations'} <= self.schemas.keys():
            raise CapturePolicyBlocked('hermes_schema_unqualified')
        # The native ResponseStore envelope explicitly binds each response to a session.
        while True:
            before = (len(self.sessions), len(self.responses))
            ids = sorted(self.sessions)
            query = RESPONSE_METADATA + ''' WHERE json_valid(data)
                AND json_type(data,'$.session_id')='text' AND json_extract(data,'$.session_id') IN (''' + ','.join('?' for _ in ids) + ') LIMIT ' + str(MAX_RESPONSES + 1)
            pending = list(self.response.reader.execute(query, ids))
            while pending:
                response_id, session, predecessor = pending.pop()
                response_id, session = text(response_id), text(session)
                predecessor = text(predecessor, optional=True)
                if any(len(value.encode('utf8')) > 480 for value in [response_id, session, predecessor or '']):
                    raise CapturePolicyBlocked('source_metadata_limit')
                if response_id in self.responses:
                    continue
                if len(self.responses) >= MAX_RESPONSES:
                    raise CapturePolicyBlocked('source_metadata_limit')
                self._session(session)
                self.responses[response_id] = session
                self.predecessors[response_id] = predecessor
                if predecessor:
                    row = self.response.reader.execute(RESPONSE_METADATA +
                        ' WHERE response_id=? AND json_valid(data)', (predecessor,)).fetchone()
                    if row is None:
                        raise CapturePolicyBlocked('hermes_reference_missing')
                    pending.append(row)
            if before == (len(self.sessions), len(self.responses)):
                break
        for response in self.responses:
            seen = set()
            while response:
                if response in seen:
                    raise CapturePolicyBlocked('hermes_reference_invalid')
                seen.add(response)
                response = self.predecessors[response]
        if any(m.get('source') == 'api_server' and sid not in self.responses.values() for sid, m in self.sessions.items()):
            raise CapturePolicyBlocked('hermes_reference_missing')
        self.current()

    def records(self, inspect_row):
        yield {'schema': SCHEMA, 'selected_session': self.selected, 'sessions': sorted(self.sessions),
               'tables': self.schemas, 'preservation': 'conversation-data'}
        prompts = {m['system_prompt_hash'] for m in self.sessions.values() if m.get('system_prompt_hash')}
        def emit(database, table, row):
            inspect_row(database, table, row)
            return {'database': database, 'table': table, 'values': [encode_cell(row[c['name']]) for c in self.schemas[database + '.' + table]]}
        for session in sorted(self.sessions):
            row, = self.state.rows('sessions', ' WHERE id=?', (session,))
            yield emit('state', 'sessions', row)
            names = {c['name'] for c in self.schemas['state.messages']}
            order = ' ORDER BY ' + ('timestamp,' if 'timestamp' in names else '') + 'id'
            for row in self.state.rows('messages', ' WHERE session_id=?', (session,), order):
                yield emit('state', 'messages', row)
            if 'state.session_model_usage' in self.schemas:
                keys = sorted(self.schemas['state.session_model_usage'], key=lambda col: col['pk'] or 10000)
                order = ' ORDER BY ' + ','.join(_identifier(col['name']) for col in keys)
                for row in self.state.rows('session_model_usage', ' WHERE session_id=?', (session,), order):
                    yield emit('state', 'session_model_usage', row)
        for prompt in sorted(prompts):
            if 'state.system_prompts' not in self.schemas:
                raise CapturePolicyBlocked('hermes_reference_missing')
            rows = list(self.state.rows('system_prompts', ' WHERE hash=?', (prompt,)))
            if len(rows) != 1:
                raise CapturePolicyBlocked('hermes_reference_missing')
            if hashlib.sha256(bytes(rows[0]['prompt']) if isinstance(rows[0]['prompt'], RawText) else text(rows[0]['prompt']).encode()).hexdigest() != prompt:
                raise CapturePolicyBlocked('hermes_reference_invalid')
            yield emit('state', 'system_prompts', rows[0])
        if self.response is not None:
            for response in sorted(self.responses):
                row, = self.response.rows('responses', ' WHERE response_id=?', (response,))
                yield emit('responses', 'responses', row)
                for row in self.response.rows('conversations', ' WHERE response_id=?', (response,), ' ORDER BY name'):
                    yield emit('responses', 'conversations', row)
        self.current()

    def encoded(self, inspect_row):
        total = 0
        for count, record in enumerate(self.records(inspect_row)):
            if count >= MAX_RECORDS:
                raise CapturePolicyBlocked('source_size_limit')
            raw = json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf8') + b'\n'
            if len(raw) > MAX_RECORD_BYTES or total + len(raw) > MAX_BYTES:
                raise CapturePolicyBlocked('source_size_limit')
            total += len(raw)
            yield raw


@contextmanager
def hermes_snapshot(path, session, authorize_session):
    """No migration, checkpoint, access-time update or provider request is issued."""
    databases = []
    try:
        state = ReadDatabase(path); databases.append(state)
        response_path = Path(path).with_name('response_store.db')
        response = ReadDatabase(response_path) if os.path.lexists(response_path) else None
        if response is not None:
            databases.append(response)
        snapshot = HermesSnapshot(state, session, authorize_session, response)
        snapshot.current()
        yield snapshot
        snapshot.current()
        if response is None and os.path.lexists(response_path):
            raise CapturePolicyBlocked('source_changed')
    except (sqlite3.Error, OSError, UnicodeError):
        raise CapturePolicyBlocked('hermes_snapshot_unavailable') from None
    finally:
        for database in reversed(databases):
            database.close()
