"""Claude Code session parser for installs without Jeremy's claude_vault package.

A copy of the message rules in claude_vault.code_parser.ClaudeCodeHistoryParser
(the operator's claude_vault tool repo, commit 796e4e5), cut down to what extract-memories.py reads: one
conversation per session file, with each message's role and content. Jeremy's
extractor keeps importing claude_vault first; this module is the fallback when that
package is absent. test_claude_code_parser.py holds the two to the same messages,
and STUBS.md records the duplicate.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace


class ClaudeCodeHistoryParser:
    def parse(self, claude_path: Path) -> list:
        """One conversation for a .jsonl session file; [] when it has no messages."""
        path = Path(claude_path)
        if not (path.is_file() and path.suffix == ".jsonl"):
            return []
        conv = self._parse_session_file(path)
        return [conv] if conv else []

    def _parse_session_file(self, jsonl_path: Path):
        entries = []
        session_id = None
        with open(jsonl_path, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") == "file-history-snapshot" or entry.get("isMeta"):
                    continue
                content = (entry.get("message") or {}).get("content", "")
                if isinstance(content, str) and (
                    "<command-name>" in content or "<local-command-stdout>" in content
                ):
                    continue
                entries.append(entry)
                if not session_id:
                    session_id = entry.get("sessionId")
        messages = []
        for entry in entries:
            if entry.get("type") in ("user", "assistant"):
                message = self._parse_message(entry)
                if message:
                    messages.append(message)
        if not messages:
            return None
        return SimpleNamespace(id=session_id or jsonl_path.stem, messages=messages)

    def _parse_message(self, entry: dict):
        msg_data = entry.get("message", {})
        role = msg_data.get("role")
        if not role:
            return None
        content = self._extract_content(msg_data)
        if not content:
            return None
        if entry.get("error"):
            content = f"⚠️ **Error: {entry['error']}**\n\n{content}"
        return SimpleNamespace(role=role, content=content.strip())

    @staticmethod
    def _extract_content(msg_data: dict) -> str:
        if isinstance(msg_data.get("content"), str):
            return str(msg_data["content"])
        parts = []
        if isinstance(msg_data.get("content"), list):
            for item in msg_data["content"]:
                if isinstance(item, dict):
                    if item.get("type") == "text":
                        text = item.get("text", "")
                        if text:
                            parts.append(text)
                    elif item.get("type") == "tool_use":
                        name = item.get("name", "Tool")
                        parts.append(
                            f"**[Tool: {name}]**\n```json\n{json.dumps(item.get('input', {}), indent=2)}\n```"
                        )
                elif isinstance(item, str):
                    parts.append(item)
        return "\n\n".join(parts)
