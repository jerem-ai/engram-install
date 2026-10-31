"""Classify native Codex session origin without reading conversational instructions."""
from __future__ import annotations
from collections.abc import Iterable


def codex_secondary_session(metadata: dict) -> bool:
    """Guardian and delegated threads are machine tasks, including older schemas.

    A parent ID alone also occurs on legitimate forks. Quoted message text is
    deliberately irrelevant to this classification.
    """
    if not isinstance(metadata, dict):
        return False
    thread = metadata.get('thread_source')
    if isinstance(thread, str) and (thread == 'guardian_review' or thread == 'subagent' or thread.startswith('subagent_')):
        return True
    source = metadata.get('source')
    return (isinstance(source, dict) and 'subagent' in source
            or isinstance(source, str) and source in ('subagent', 'guardian_review'))


def guardian_review_only(user_turns: Iterable[str]) -> bool:
    """Recognize older review transcripts while retaining later direct human turns."""
    prefix = 'the following is the codex agent history whose request action you are assessing'
    seen = False
    for text in user_turns:
        text = text.strip()
        if not text:
            continue
        seen = True
        if text[:len(prefix)].lower() != prefix:
            return False
    return seen
