"""Reader for ~/.config/engram/engram.env, the per-install settings file.

Same format and key list as runtime/hooks/engram-env.mjs,
runtime/src/lib/install-config.ts and runtime/scripts/engram-env.sh; the four are
held equal by runtime/test/install-config-parity.test.ts. KEY=VALUE lines, #
comments, optional matching quotes, and a leading ~ or $HOME expands to the home
directory. Only ENGRAM_ENV_KEYS are read; tenant identity never comes from here.

A missing file means no settings, so every caller keeps its built-in default.
Jeremy's machines have no engram.env.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ENGRAM_ENV_KEYS = (
    "ENGRAM_HOME", "KG_VAULT_PATH", "KG_DATA_DIR", "ENGRAM_RUNTIME_DIR", "ENGRAM_NODE",
    "ENGRAM_HTTP_URL", "ENGRAM_EXTRACT_BACKEND", "ENGRAM_CLI_DRIVER", "ENGRAM_MEMORY_ROOT",
    "ENGRAM_LABEL_PREFIX", "ENGRAM_USER_NAME", "ENGRAM_PERSONA", "ENGRAM_MEMORY_PROJECTS",
    "ENGRAM_STATE_DIR", "ENGRAM_NOTIFY", "ENGRAM_TENANT_ENV_FILE", "CODEX_HOME",
    "ENGRAM_MIN_SCORE", "ENGRAM_MCP_ADMISSION", "ENGRAM_SINCE_DAYS", "ENGRAM_ARCHIVE_DIR",
)
_LINE = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")


def engram_env_path(home: Path | None = None) -> Path:
    return (home or Path.home()) / ".config" / "engram" / "engram.env"


def parse_engram_env(text: str, home: Path | None = None) -> dict[str, str]:
    root = str(home or Path.home())
    out: dict[str, str] = {}
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _LINE.match(line)
        if not m or m.group(1) not in ENGRAM_ENV_KEYS:
            continue
        value = m.group(2).strip()
        if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
            value = value[1:-1]
        if value in ("~", "$HOME"):
            value = root
        elif value.startswith("~/"):
            value = root + value[1:]
        elif value.startswith("$HOME/"):
            value = root + value[5:]
        if value:
            out[m.group(1)] = value
    return out


def read_engram_env(home: Path | None = None) -> dict[str, str]:
    """Settings from the file, or {} when it is absent or unreadable."""
    try:
        text = engram_env_path(home).read_text()
    except OSError:
        return {}
    return parse_engram_env(text, home)


if __name__ == "__main__":
    # Parity test entry: parse a file and print sorted KEY=VALUE lines.
    for key, value in sorted(parse_engram_env(Path(sys.argv[1]).read_text(), Path(sys.argv[2])).items()):
        print(f"{key}={value}")
