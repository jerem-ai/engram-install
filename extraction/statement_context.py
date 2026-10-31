"""Unreviewed statement annotations; these never establish support or authority."""

KINDS = ('fact', 'preference', 'standing_instruction', 'advice', 'task_request', 'unknown')
SCOPES = ('task', 'project', 'portable', 'unknown')
STATEMENT_SCHEMA = {
    'type': 'object',
    'properties': {'kind': {'type': 'string', 'enum': list(KINDS)},
                   'scope': {'type': 'string', 'enum': list(SCOPES)}},
    'required': ['kind', 'scope'], 'additionalProperties': False,
}


def statement_context(item):
    value = item.get('statement')
    if value is None:
        return {'kind': 'unknown', 'scope': 'unknown', 'review': 'unreviewed'}
    if (not isinstance(value, dict) or set(value) != {'kind', 'scope'}
            or value['kind'] not in KINDS or value['scope'] not in SCOPES):
        raise ValueError('statement needs an allowed kind and scope')
    if value['kind'] == 'task_request':
        raise ValueError('one-time task requests belong in session history')
    if value['kind'] == 'standing_instruction' and value['scope'] not in ('project', 'portable'):
        raise ValueError('standing instructions need their project or portable scope')
    return {**value, 'review': 'unreviewed'}
