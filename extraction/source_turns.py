"""Message anchors for exact quoted evidence. Native roles grant no authority."""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json
import re

from capture_policy import current_capture_sources
from hermes_snapshot import encode_cell, text

_SCOPE = ContextVar('engram_source_turns', default=None)
MAX_TEXT_BYTES = 64 * 1024 * 1024
MAX_TURNS = 65536
MAX_REFERENCES = 256
MAX_CONTEXT_BYTES = 32768
MAX_QUOTE_CONTEXT_BYTES = 16384
MAX_CONTEXT_QUOTES = 32
SENSITIVE_CONTEXT = re.compile(
    r'-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}'
    r'|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
    r'|\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\s*[=:]\s*[\"\']?[^\s\"\']{8,}',
    re.I,
)


def _sha(value):
    return hashlib.sha256(value.encode('utf8')).hexdigest()


class QuoteTurnIndex:
    def __init__(self, session_id):
        self.session_id = session_id
        self.rows = []
        self.bytes = 0
        self.incomplete = False
        self.source = None
        self.transcript = ''
        self.projection = None

    def seal(self, source, transcript):
        self.source = dict(source)
        self.projection = None
        if isinstance(transcript, str):
            self.transcript = transcript
        elif isinstance(getattr(transcript, 'messages', None), list):
            self.transcript = '\n'.join(m.content for m in transcript.messages
                if getattr(m, 'role', None) in ('user', 'assistant') and isinstance(getattr(m, 'content', None), str))

    def bind_projection(self, transcript, segments):
        """Bind trusted renderer offsets to exact native messages, never role text.

        Segments carry the original message and the rendered payload offsets.
        Synthetic tool renderings, ambiguous messages and elided ranges remain
        explicitly incomplete. No passage bytes or native records are changed.
        """
        self.transcript = transcript
        self.projection = []
        native = {}
        for i, (content, ref) in enumerate(self.rows):
            native.setdefault((ref['native_role'], content), []).append(i)
        for start, end, body_start, role, original in segments:
            matches = native.get((role, original), [])
            self.projection.append((start, end, body_start, matches))

    def _locations(self, quote):
        if quote not in self.transcript:
            return [], 'not_in_projection'
        if self.projection is None:
            matches = [i for i, (content, _) in enumerate(self.rows) if quote in content]
            return matches, ('complete' if len(matches) == 1 else
                             'ambiguous_quote' if matches else 'no_native_match')
        starts = []; offset = 0
        while (offset := self.transcript.find(quote, offset)) >= 0:
            starts.append(offset); offset += 1
            if len(starts) > 1:
                return [], 'ambiguous_quote'
        start = starts[0]; end = start + len(quote); cursor = start; positions = []
        for left, right, body_start, matches in self.projection:
            if right <= start or left >= end:
                continue
            if left > cursor or len(matches) != 1:
                return [], 'no_native_match'
            cursor = max(cursor, min(right, end))
            if min(right, end) > max(body_start, start):
                positions.extend(matches)
        if cursor < end or not positions:
            return [], 'no_native_match'
        return list(dict.fromkeys(positions)), 'complete'

    def references(self, item, source_session):
        if self.source is None or source_session != self.source['source_id']:
            return None
        sources = current_capture_sources() or []
        if not any(s['source_id'] == source_session and s['revision'] == self.source['revision'] for s in sources):
            return None
        quotes = list(item.get('passages') or [])
        for claim in item.get('assertions') or []:
            if isinstance(claim, dict):
                quotes.extend(claim.get('passages') or [])
        quotes = list(dict.fromkeys(q for q in quotes if isinstance(q, str) and q))
        references = [];complete = not self.incomplete and bool(quotes)
        if len(quotes) > 256 or sum(len(q.encode('utf8')) for q in quotes) > 65536:
            return {'schema': 'engram.source-turns.v1', 'authority': 'historical_untrusted',
                    'quotes_complete': False, 'references': []}
        for quote in quotes:
            positions, status = self._locations(quote)
            matches = [self.rows[i][1] for i in positions]
            if self.projection is not None and status != 'complete':
                matches = []
            if not matches or len(references) + len(matches) > MAX_REFERENCES:
                complete = False
                continue
            references.extend({'quote_sha256': _sha(quote), 'source_id': source_session,
                'revision': self.source['revision'], **ref} for ref in matches)
        return {'schema': 'engram.source-turns.v1', 'authority': 'historical_untrusted',
                'quotes_complete': complete, 'references': references,
                **({'projection_sha256': _sha(self.transcript)} if self.projection is not None else {})}

    def citation_context(self, item, source_session):
        """Retain complete nearby native turns without changing quotes or judge inputs.

        A complete window is two preceding conversational turns, the quoted turn,
        and one following turn, bounded by the captured session. Completion only
        describes this window; it certifies no semantic support or human identity.
        """
        # Reuse adapter-specific session normalization without scanning all quotes
        # twice; write_memory already obtains the original reference manifest.
        if self.references({}, source_session) is None:
            return None
        quotes = list(item.get('passages') or [])
        for claim in item.get('assertions') or []:
            if isinstance(claim, dict):
                quotes.extend(claim.get('passages') or [])
        quotes = list(dict.fromkeys(q for q in quotes if isinstance(q, str) and q))
        result = {'schema': 'engram.citation-context.v1', 'authority': 'historical_untrusted',
                  'source_id': self.source['source_id'], 'revision': self.source['revision'],
                  'window': {'preceding_turns': 2, 'following_turns': 1},
                  'complete': False, 'entries': []}
        if len(quotes) > MAX_CONTEXT_QUOTES:
            result['reason'] = 'quote_limit'
            return result
        used = 0
        for quote in quotes:
            entry = {'quote_sha256': _sha(quote), 'status': 'complete', 'turns': []}
            matches, status = self._locations(quote)
            if self.incomplete:
                entry['status'] = 'index_incomplete'
            elif status != 'complete':
                entry['status'] = status
            else:
                position = min(matches); last = max(matches)
                window_start = max(0, position - 2)
                window = self.rows[window_start:last + 2]
                size = sum(len(content.encode('utf8')) for content, _ in window)
                limited = size > MAX_QUOTE_CONTEXT_BYTES or used + size > MAX_CONTEXT_BYTES
                sensitive = any(SENSITIVE_CONTEXT.search(content) for content, _ in window)
                if limited or sensitive:
                    # Keep the whole quoted turn when neighbors cannot be retained.
                    # This is explicitly partial, even at a session boundary.
                    quoted = [self.rows[i] for i in matches]
                    size = sum(len(content.encode('utf8')) for content, _ in quoted)
                    if any(SENSITIVE_CONTEXT.search(content) for content, _ in quoted):
                        entry['status'] = 'sensitive_context'
                    elif size > MAX_QUOTE_CONTEXT_BYTES or used + size > MAX_CONTEXT_BYTES:
                        entry['status'] = 'context_limit'
                    else:
                        entry.update(status='quoted_turn_only', quote_turn=0,
                                     reason='context_limit' if limited else 'sensitive_neighbors',
                                     turns=[{'text': content, 'text_sha256': _sha(content), **ref}
                                            for content, ref in quoted])
                        if len(matches) > 1:entry['quote_turns'] = list(range(len(matches)))
                        used += size
                else:
                    entry['quote_turn'] = position - window_start
                    if len(matches) > 1:entry['quote_turns'] = [i - window_start for i in matches]
                    entry['turns'] = [{'text': content, 'text_sha256': _sha(content), **ref}
                                      for content, ref in window]
                    used += size
            result['entries'].append(entry)
        result['complete'] = bool(quotes) and all(e['status'] == 'complete' for e in result['entries'])
        return result


class HermesTurnIndex(QuoteTurnIndex):
    def add(self, row):
        if text(row.get('session_id'), optional=True) != self.session_id:
            self.incomplete = True
            return
        if row.get('active', 1) != 1:
            return
        role = text(row.get('role'), optional=True)
        content = text(row.get('content'), optional=True)
        if role not in ('user', 'assistant') or not content:
            return
        raw_size = len(content.encode('utf8'))
        if len(self.rows) >= MAX_TURNS or self.bytes + raw_size > MAX_TEXT_BYTES:
            self.incomplete = True
            return
        native_id = encode_cell(row.get('id'))
        if native_id[0] not in ('integer', 'text') or not native_id[1] or len(native_id[1].encode('utf8')) > 512:
            self.incomplete = True
            return
        canonical = json.dumps({key: encode_cell(value) for key, value in row.items()},
            sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        self.rows.append((content, {'record_format': 'engram.hermes-message.v1',
                                  'database': 'state', 'table': 'messages',
                                  'native_id': native_id, 'native_role': role,
                                  'record_sha256': _sha(canonical)}))
        self.bytes += raw_size



class JsonlTurnIndex(QuoteTurnIndex):
    """Physical 1-based record locations in the exact captured bytes, including LF.

    Only native conversational text participates. Generated tool renderings and
    synthetic event mirrors cannot supply a message anchor. Missing native IDs
    are normal; the ordinal and record hash still locate the original record.
    """
    def __init__(self, runtime, session_id):
        super().__init__(session_id)
        self.runtime = runtime

    def references(self, item, source_session):
        if self.source is None or source_session not in (self.session_id, self.source['source_id']):
            return None
        return super().references(item, self.source['source_id'])

    def add_record(self, record, ordinal, raw):
        role = content = pointer = native_id = None
        if self.runtime == 'claude-code' and record.get('type') in ('user', 'assistant') and not record.get('isMeta'):
            message = record.get('message')
            if isinstance(message, dict):
                role = message.get('role');content = message.get('content');pointer = '/message'
                if isinstance(content, str) and ('<command-name>' in content or '<local-command-stdout>' in content):
                    return
                native_id = record.get('uuid')
        elif self.runtime == 'codex' and record.get('type') == 'response_item':
            message = record.get('payload')
            if isinstance(message, dict) and message.get('type') == 'message':
                role = message.get('role');content = message.get('content');pointer = '/payload'
                native_id = message.get('id')
        elif self.runtime == 'openclaw':
            if record.get('type') == 'message' and isinstance(record.get('message'), dict):
                message = record['message'];role = message.get('role');content = message.get('content');pointer = '/message'
                native_id = record.get('id')
            elif record.get('type') in ('prompt.submitted', 'model.completed') and isinstance(record.get('data'), dict):
                if record['type'] == 'prompt.submitted':
                    role = 'user';content = record['data'].get('prompt');pointer = '/data/prompt'
                else:
                    role = 'assistant';content = record['data'].get('assistantTexts');pointer = '/data/assistantTexts'
                native_id = record.get('eventId', record.get('id'))
        if role not in ('user', 'assistant') or pointer is None:
            return
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, str) and (self.runtime == 'claude-code' or pointer == '/data/assistantTexts'):
                    parts.append(part)
                elif isinstance(part, dict) and (self.runtime != 'claude-code' or part.get('type') == 'text'):
                    parts.append(part.get('text', ''))
            separator = '\n\n' if self.runtime == 'claude-code' else '\n' if pointer == '/data/assistantTexts' else ' '
            content = separator.join(part for part in parts if isinstance(part, str) and part)
        if not isinstance(content, str) or not content.strip():
            return
        size = len(content.encode('utf8'))
        if len(self.rows) >= MAX_TURNS or self.bytes + size > MAX_TEXT_BYTES:
            self.incomplete = True
            return
        ref = {'record_format': 'engram.jsonl-record.v1', 'record_ordinal': str(ordinal),
               'message_path': pointer, 'native_role': role,
               'record_sha256': hashlib.sha256(raw).hexdigest()}
        if isinstance(native_id, str) and native_id and len(native_id.encode('utf8')) <= 512:
            ref['native_id'] = ['text', native_id]
        self.rows.append((content, ref));self.bytes += size


@contextmanager
def source_turn_scope(index):
    marker = _SCOPE.set(index)
    try:
        yield
    finally:
        _SCOPE.reset(marker)


def current_source_turns(item, source_session):
    index = _SCOPE.get()
    return index.references(item, source_session) if index is not None else None


def bind_current_projection(transcript, segments):
    index = _SCOPE.get()
    if index is not None:
        index.bind_projection(transcript, segments)


def current_citation_context(item, source_session):
    index = _SCOPE.get()
    return index.citation_context(item, source_session) if index is not None else None
