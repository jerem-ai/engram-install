#!/opt/homebrew/bin/python3.12
# Launchers call the release venv explicitly: "$SCRIPT_DIR/venv/bin/python".
"""
extract-memories.py — mine Claude Code transcripts for durable memories.

For each session JSONL not yet processed (or grown since last run), send the
transcript to the configured extraction backend with the MEMORY EXTRACTION PROTOCOL and write any NEW
memory files into that project's ~/.claude/projects/<encoded>/memory/ dir.
The vault mirror + KG pick them up downstream.

Idempotent: state file tracks (session_id -> msg_count, mtime). A session is
re-processed only if it grew. Existing memory (MEMORY.md + filenames) is sent as
dedup context so the model doesn't re-emit what's already captured.

Cost controls: tool output stripped, per-message + per-session char caps,
prompt caching on the static system prompt.

Flags:
  --dry-run        parse + call model, print candidates, write nothing
  --limit N        process at most N sessions this run
  --project SUBSTR only sessions whose encoded project dir contains SUBSTR
  --since-days N   only sessions with mtime within N days
  --model ID       override model (runner default: the operator lane's model)
"""

import os
import re
import shlex
import subprocess
import sys
import json
import argparse
import urllib.request
from pathlib import Path
from datetime import datetime, timezone, timedelta

try:
    from claude_vault.code_parser import ClaudeCodeHistoryParser
except ImportError:  # a fresh install has no claude_vault package; same message rules, vendored
    from claude_code_parser import ClaudeCodeHistoryParser
from request_sizing import size_request
import support_check
from install_config import read_engram_env

# Per-install settings (~/.config/engram/engram.env). They only fill gaps, and with no
# file (Jeremy's machines) every value below is the one this script always used.
INSTALL = read_engram_env()
PROJECTS = Path(INSTALL.get("ENGRAM_MEMORY_ROOT", Path.home() / ".claude" / "projects"))
STATE_DIR = Path(INSTALL.get("ENGRAM_STATE_DIR", Path.home() / ".local" / "share" / "memory-extraction"))
USER_NAME = INSTALL.get("ENGRAM_USER_NAME", "Jeremy")
PERSONA = INSTALL.get("ENGRAM_PERSONA", "jeremy")
STATE_FILE = STATE_DIR / "state.json"
DEFAULT_MODEL = "claude-haiku-4-5-20251001"

MAX_MSG_CHARS = 6000        # truncate any single message
MAX_SESSION_CHARS = 300000  # cap whole transcript (~75k tokens; Haiku ctx is 200k)

EXCLUDED_PROJECT_SUBSTR = ("-private-tmp", "-private-var-folders", "openclaw-tmp")

# Claude Code encodes a session's cwd into its project dir name; cwd "/" becomes
# the bare "-" dir. Every transcript there is a single-turn `sdk-cli` batch call
# (morning-brief judgment layer, note extractors, identity prompts), not a
# conversation, and mining them minted a junk store of 376 memories by 2026-09-12.
# Adapter routing already refuses "/" (see _routed_mem_dir); this makes the
# Claude Code path agree.
ROOT_CWD_PROJECT_DIR = "-"

# Reuse the source map's vocabulary, never its folder-to-project assignments:
# a session can discuss a different project or a portable working preference.
RUNTIME_DIR = Path(os.environ.get("ENGRAM_RUNTIME_DIR", Path(__file__).resolve().parents[1] / "runtime"))
PROJECTS_MAP = Path(INSTALL.get("ENGRAM_MEMORY_PROJECTS", RUNTIME_DIR / "config/memory-projects.json"))
PROJECT_NAMES = sorted(set(json.loads(PROJECTS_MAP.read_text())["source_slugs"].values()))


def project_dir_excluded(name: str) -> bool:
    """True when a ~/.claude/projects/<name> dir must never be mined."""
    return name == ROOT_CWD_PROJECT_DIR or any(s in name for s in EXCLUDED_PROJECT_SUBSTR)

SYSTEM_PROMPT = """You mine a Claude Code session transcript for durable MEMORIES worth keeping for future sessions on this project. You are given the transcript and the list of memories ALREADY captured. Emit only NEW memories not already covered.

CRITICAL — most transcripts are NOT a human chatting. Many are automated agent runs where the "User" turn is actually a SYSTEM PROMPT, agent task instruction, MCP/tool protocol, or operating spec (e.g. "You are a memory consolidation agent", "send output via the reply tool", heartbeat/sweep instructions, compression rules). These are NEVER memories. Do not turn an agent's own instructions into a "user" preference or "feedback". If the User turns read like a system/agent prompt rather than a real person collaborating, return [].

Only extract signal a HUMAN (Jeremy) expressed conversationally while working.

CRITICAL — durable vs ephemeral. A memory must be a STANDING fact, preference, or decision that holds across future sessions. REJECT one-time in-session requests and task goals — these are ephemeral, not memories:
- "print the raw output now", "stop and show me X", "finish the room set", "run the tests", "fix this bug" → ephemeral task instructions. NOT memories.
- "I always want X", "I hate Y", "never do Z", "we decided to use X architecture", "the API key lives at P" → durable. These ARE memories.
Test: would this still matter, unchanged, three sessions from now on this project? If it's tied to the moment ("do this next"), it is NOT a memory. When unsure, omit.

CRITICAL — reversals. A long session often builds something, then later reverses, supersedes, or tears it out. Capture ONLY the FINAL state. If an approach/decision/config is introduced and then abandoned or replaced later in the transcript, do NOT emit a memory describing the abandoned version — it will be false going forward. When the transcript ends on a different decision than it started, the ending one wins.


EVIDENCE — every memory MUST carry at least one passage: an EXACT substring copied
character-for-character from the transcript that supports it. Copy, never retype or
paraphrase; the passage is checked against the transcript and a near-miss fails.
Prefer the user's own words over the assistant's. If you cannot find a verbatim
passage that supports a memory, that memory is inference, not evidence — omit it.
Never attribute to Jeremy something only the assistant proposed; if the passage you
would cite is the assistant speaking, the memory is not a user preference.

Four types:
- feedback: a correction the user gave, OR a non-obvious approach they validated without pushback. Lead with the rule, then why, then how to apply.
- user: a durable fact about the user's role, expertise, preferences, or working style that changes how to collaborate.
- project: a significant decision, milestone, architectural choice, or known blocker useful at the start of the next session.
- reference: an external system/tool/resource named with a purpose.

Do NOT emit:
- a restatement of anything already in the provided existing-memory list (dedup hard). EXCEPTION, supersession: if the transcript shows a durable decision, value, or tool that REPLACES an existing memory (a choice reversed, a number changed, a component swapped), emit the NEW memory and set "supersedes" to the EXACT filename of the memory it replaces, copied from the existing-memory list. Declare supersession only when the old memory is now false; a still-true memory that merely resembles the new one is NOT superseded. Never set "supersedes" to a filename that is not in the list.
- things derivable from code or git history
- ephemeral task detail only relevant within that session
- generic coding knowledge

HIGH-VALUE — actively capture these even from long "working"/build sessions, where they are most often buried and missed:
- an architectural DECISION and its rationale (why X over Y, how components relate, where responsibility lives)
- a design-system rule or convention and the reasoning behind it
- a hard-won GOTCHA / non-obvious constraint discovered during the work — e.g. a config value that causes silent failure, an API auth quirk, an ID/format/prefix that must match exactly to work
A session that designs or builds something usually contains at least one such durable decision or gotcha. Do NOT return [] merely because it was a hands-on build session rather than a chat — look for the standing decision/constraint underneath the work.

Be conservative with everything else: ephemeral task steps, transient bugs, and borderline items — emit nothing rather than noise. The bar is unchanged; this only says don't let real architecture/decisions/gotchas slip through because they were embedded in a working session.

SCOPE FIELDS: classify the memory's meaning from its cited passages. The session's
working directory is not its semantic scope. Set project only when the memory
applies to one named project in the allowed vocabulary below. Use null for an
unknown project, multiple projects, or a portable preference. Do not guess a
project from a generic word shared by several projects.
For feedback only, set feedback_kind to working_style for portable collaboration,
communication, verification or operating methods, including delivery preferences;
set it to domain for a rule about a particular product, technical system or subject.
Use null when ambiguous or when type is not feedback. A technical example does
not turn a portable working preference into domain feedback. These fields are
unreviewed model annotations, and do not establish support or retrieval authority.

TYPED CLAIMS: include assertions, an array of at most ten atomic claims supported
by this memory's passages. Use a specific lowercase predicate such as prefers,
uses, depends_on, runs_on, forbids, or a precise dotted namespace. Never use
relates_to, part_of, is, or claims as a substitute for the actual relationship.
Each assertion has subject, predicate, object, passages, valid_from and valid_to.
Copy supporting passages verbatim from the transcript. Dates are null unless
the cited passage explicitly states a full ISO timestamp with seconds and a
timezone; copy that timestamp exactly. Never infer a timezone, midnight, an end
date, or a start date from the session date. A proposal, conditional, quotation
or assistant suggestion is not an established fact. Preserve uncertainty and
later corrections; omit claims that cannot be supported. Use [] when no atomic
claim qualifies. These are unreviewed candidates, never promoted truth.

Return STRICT JSON: an array of objects, each:
{"type":"feedback|user|project|reference","slug":"kebab-case-short","description":"one line, specific enough to judge relevance later","body":"the memory; for feedback/project include Why and How-to-apply","passages":["exact verbatim substring copied from the transcript that supports this memory"],"supersedes":"optional: exact existing filename this memory replaces; omit unless the old memory is now false"}
Also include project (an allowed name or null) and feedback_kind
(working_style, domain, or null), plus assertions on each object.
Return [] if nothing qualifies. No prose outside the JSON."""
SYSTEM_PROMPT = SYSTEM_PROMPT.replace("Jeremy", USER_NAME)  # two mentions, both the human
SYSTEM_PROMPT += "\nAllowed project names: " + ", ".join(PROJECT_NAMES) + "."

# The codex driver only. Codex read "Only extract signal a HUMAN ... expressed" as
# covering every type, and returned nothing from sessions where Jeremy asked one
# question and the assistant found the answer (Gate 2, October 20: asked why on
# 4326614d, 4e66d53d and 537ea2fe, it quoted that rule or the standing-fact rule).
# Claude reads the HIGH-VALUE list as covering those findings. The note says how the
# rules apply; SYSTEM_PROMPT is unchanged for the claude driver and every other backend.
CODEX_READING_NOTE = """HOW TO READ THE RULES ABOVE. The rule that signal must come from a HUMAN governs user and feedback memories: a preference, correction or working style must be in Jeremy's own words. It does not make a session empty because Jeremy only asked a question or pasted a handoff. When Jeremy asks for help and the assistant investigates, what the session established is project or reference material: a gotcha or constraint the assistant confirmed from command output, where a system lives and how it is set up, how it fails, a decision reached, a blocker still open. Those are standing facts when they will still hold next session, and the assistant's own words can be the passage. A proposal or guess the session never confirmed is still not a memory. Before you return no memories, read the HIGH-VALUE list again against what the assistant found.""".replace("Jeremy", USER_NAME)

MEMORY_RESPONSE_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "type": {"type": "string", "enum": ["feedback", "user", "project", "reference"]},
            "slug": {"type": "string"},
            "description": {"type": "string"},
            "body": {"type": "string"},
            "passages": {"type": "array", "items": {"type": "string"}},
            "supersedes": {"type": "string"},
            "project": {"type": ["string", "null"], "enum": [*PROJECT_NAMES, None]},
            "feedback_kind": {"type": ["string", "null"], "enum": ["working_style", "domain", None]},
            "assertions": {"type": "array", "maxItems": 10, "items": {
                "type": "object", "properties": {
                    "subject": {"type": "string"}, "predicate": {"type": "string"},
                    "object": {"type": "string"},
                    "passages": {"type": "array", "items": {"type": "string"}},
                    "valid_from": {"type": ["string", "null"]}, "valid_to": {"type": ["string", "null"]},
                }, "required": ["subject", "predicate", "object", "passages", "valid_from", "valid_to"],
                "additionalProperties": False,
            }},
        },
        "required": ["type", "slug", "description", "body", "passages"],
        "additionalProperties": False,
    },
}


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(STATE_FILE)


def strip_tools(text: str) -> str:
    # collapse obvious tool noise the parser may have inlined
    text = re.sub(r"\[tool[_ ]?(use|result)[^\]]*\]", "[tool]", text, flags=re.I)
    return text


# Signatures of automated agent/heartbeat runs — first human turn matches these.
# These sessions are system-prompt-driven automation with no durable human memory;
# skip them in code (no model call) for speed + zero false-positive risk.
AGENT_SIGNATURES = (
    "final assistant text is not automatically delivered",
    "read heartbeat.md",
    "you are a memory consolidation agent",
    "you are a memory-consolidation agent",
    "quiet internal sweep",
    "internal sweep across",
    "use the `message` tool to send user-visible output",
    "compress the daily log",
)


def is_agent_session(conv, extra_signatures=()) -> bool:
    for m in conv.messages:
        if m.role in ("human", "user") and (m.content or "").strip():
            head = m.content[:600].lower()
            # OpenClaw/Hermes cron dispatches prefix the first turn with the
            # cron job id — automation by construction, no signature needed.
            if head.startswith("[cron:"):
                return True
            return any(sig in head for sig in AGENT_SIGNATURES + tuple(extra_signatures))
    return False


# Harness envelopes are not the user's words: Conductor opens every workspace with a
# <system_instruction> block, and reminders arrive as <system-reminder>. Only whole
# blocks on their own lines go, so a question that names the tag inline stays (the
# recall hook's rule, runtime/hooks/recall-core.mjs, adjudication batch-001 C04). The
# codex driver read a session that opens with one as an agent run and returned nothing
# (Gate 2, October 17), so the cli backend strips them from user turns.
ENVELOPE = re.compile(r"^[ \t]*<(system_instruction|system-reminder)>[\s\S]*?</\1>[ \t]*$", re.M)


def strip_envelopes(text: str) -> str:
    return ENVELOPE.sub(" ", text)


def build_transcript(conv, envelopes: bool = True) -> str:
    """The transcript the model reads. `envelopes=False` drops harness envelopes from user turns."""
    parts = []
    for m in conv.messages:
        role = "User" if m.role in ("human", "user") else "Claude"
        content = strip_tools(m.content or "").strip()
        if not envelopes and role == "User":
            content = strip_envelopes(content).strip()
        if not content:
            continue
        if len(content) > MAX_MSG_CHARS:
            content = content[:MAX_MSG_CHARS] + " …[truncated]"
        parts.append(f"## {role}\n{content}")
    text = "\n\n".join(parts)
    if len(text) > MAX_SESSION_CHARS:
        # keep head + tail (decisions often land at the end)
        head = text[: MAX_SESSION_CHARS // 2]
        tail = text[-MAX_SESSION_CHARS // 2 :]
        text = head + "\n\n…[middle elided]…\n\n" + tail
    return text


ROUTING_MAP = PROJECTS / ".memory-routing.json"


def canonical_memory_dir(proj: Path) -> Path:
    """Resolve a session's project dir to the canonical memory store for its project.

    Memories are keyed by working directory, so one project spread across several
    Conductor workspaces used to get an isolated store per workspace: the
    session-start index showed only that slice, and existing_memory_context() could
    not see siblings, so the extractor re-emitted facts already captured elsewhere
    (16 exact-name duplicates found 2026-08-09).

    Matching is on PROJECT IDENTITY rather than a fixed list of known slugs,
    because a static list only covers workspaces that already existed: a freshly
    created conductor/workspaces/maestro/tokyo would otherwise start a new silo on
    first use. Order is explicit override, then longest-first name match. Unknown
    projects keep the old per-directory behaviour, as does deleting the map.
    """
    try:
        cfg = json.loads(ROUTING_MAP.read_text())
    except (OSError, ValueError):
        return proj / "memory"
    target = cfg.get("overrides", {}).get(proj.name)
    if not target:
        slug = proj.name.lower()
        for name in cfg.get("names", []):
            if name in slug:
                target = cfg.get("projects", {}).get(name)
                break
    if not target or target == proj.name:
        return proj / "memory"
    return proj.parent / target / "memory"


ARCHIVE_HOST = os.environ.get("ENGRAM_ARCHIVE_HOST", "um790")
ARCHIVE_ROOT = os.environ.get(
    "ENGRAM_ARCHIVE_ROOT", "/mnt/tree-nas-backups/Engram/transcripts"
)
ARCHIVE_READ_COMMAND = os.environ.get(
    "ENGRAM_ARCHIVE_READ_COMMAND", "/usr/local/bin/engram-archive-read"
)


def archived_transcript(session_id: str) -> str | None:
    """Fetch a session from the transcript archive host when the local copy is gone.

    Claude Code expires transcripts at ~30 days. archive-transcripts.sh preserves
    them, but preservation is useless if nothing reads it: without this the
    extractor and auditor still see an expired session as missing and a memory
    older than a month can never be re-extracted or checked.
    """
    try:
        remote_read = " ".join(
            (
                shlex.quote(ARCHIVE_READ_COMMAND),
                shlex.quote(session_id),
                shlex.quote(ARCHIVE_ROOT),
            )
        )
        got = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", ARCHIVE_HOST,
             remote_read], capture_output=True, text=True, timeout=120)
        return got.stdout if got.returncode == 0 and got.stdout else None
    except Exception:
        return None  # archive is a fallback; never let it break a live run


def existing_memory_context(mem_dir: Path) -> str:
    if not mem_dir.is_dir():
        return "(none yet)"
    lines = []
    idx = mem_dir / "MEMORY.md"
    if idx.exists():
        lines.append("MEMORY.md index:\n" + idx.read_text()[:3000])
    names = [p.name for p in mem_dir.glob("*.md") if p.name != "MEMORY.md"]
    if names:
        lines.append("existing memory files: " + ", ".join(sorted(names)))
    return "\n\n".join(lines) or "(none yet)"


def mark_superseded(old: Path, new_name: str) -> bool:
    """Loop A inert mark: record on OLD that NEW replaced it.

    Writes top-level `superseded_by` + `valid_to` (PLAN_TRUTH_MAINTENANCE_2026-08-19,
    pinned vocabulary). Top-level because curated-key preservation in write_memory
    carries top-level keys through a later re-extraction and drops metadata-nested
    ones (F11). Never writes `stale`: that flag is live at the next query, these
    marks are retrieval-inert until the gated promotion (G-A3). COALESCE semantics:
    an existing superseded_by is never overwritten, so the first replacement wins
    and a later mistaken claim cannot silently re-point history. Any failure is a
    WARN, never a run failure. Reverse with unmark-supersession.py (FM-A1).
    """
    try:
        import frontmatter as _fmlib
        post = _fmlib.load(old)
        if post.metadata.get("superseded_by"):
            return False
        post.metadata["superseded_by"] = new_name
        post.metadata["valid_to"] = datetime.now(timezone.utc).astimezone().isoformat()
        tmp = old.with_suffix(".md.tmp")
        tmp.write_text(_fmlib.dumps(post) + "\n")
        os.replace(tmp, old)
        return True
    except Exception as e:
        print(f"  WARN: could not mark {old.name} superseded by {new_name}: {e}", file=sys.stderr)
        return False


def validate_items(items: list, transcript: str) -> None:
    """Check the complete batch before any writes; quoted text is not proof of support."""
    for index, item in enumerate(items):
        if not isinstance(item, dict) or any(
            not isinstance(item.get(key), str) or not item[key].strip()
            for key in ("type", "slug", "description", "body")
        ) or item["type"] not in ("feedback", "user", "project", "reference"):
            raise ValueError(f"memory {index}: invalid required fields")
        passages = item.get("passages")
        if not isinstance(passages, list) or not passages or any(
            not isinstance(quote, str) or not quote.strip() or quote not in transcript
            for quote in passages
        ):
            raise ValueError(f"memory {index}: passages must be exact transcript substrings")
        project, kind = item.get("project"), item.get("feedback_kind")
        if project is not None and project not in PROJECT_NAMES:
            raise ValueError(f"memory {index}: project must be an allowed name or null")
        if kind is not None and (kind not in ("working_style", "domain") or item["type"] != "feedback"):
            raise ValueError(f"memory {index}: feedback_kind is only valid on feedback")
        claims = item.get("assertions", [])
        if not isinstance(claims, list) or len(claims) > 10:
            raise ValueError(f"memory {index}: assertions must contain at most ten claims")
        triples = set()
        for claim in claims:
            if (not isinstance(claim, dict)
                    or set(claim) != {"subject", "predicate", "object", "passages", "valid_from", "valid_to"}
                    or any(not isinstance(claim[k], str) or not 1 <= len(claim[k].strip()) <= 4096
                           for k in ("subject", "predicate", "object"))
                    or not re.fullmatch(r"[a-z][a-z0-9_.]{0,79}", claim["predicate"])
                    or claim["predicate"] in {"relates_to", "part_of", "is", "claims"}):
                raise ValueError(f"memory {index}: invalid typed assertion")
            triple = tuple(claim[k].strip() for k in ("subject", "predicate", "object"))
            if triple in triples:
                raise ValueError(f"memory {index}: duplicate typed assertion")
            triples.add(triple)
            quotes = claim["passages"]
            if not isinstance(quotes, list) or not quotes or any(
                    not isinstance(q, str) or not q.strip() or q not in transcript for q in quotes):
                raise ValueError(f"memory {index}: assertion passages must be exact transcript substrings")
            dates = []
            for field in ("valid_from", "valid_to"):
                value = claim[field]
                if value is None:
                    dates.append(None)
                    continue
                if (not isinstance(value, str)
                        or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})", value)
                        or not any(value in q for q in quotes)):
                    raise ValueError(f"memory {index}: {field} needs a verbatim timezone-qualified source timestamp")
                stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if abs(stamp.utcoffset()) > timedelta(hours=14) or (value[-1] != 'Z' and int(value[-2:]) > 59):
                    raise ValueError(f"memory {index}: invalid timezone offset")
                dates.append(stamp)
            if all(dates) and dates[1] < dates[0]:
                raise ValueError(f"memory {index}: valid_to precedes valid_from")


def write_memory(mem_dir: Path, item: dict, source_session: str = "",
                 provenance: dict | None = None, slug_suffix: str = "") -> Path:
    mem_dir.mkdir(parents=True, exist_ok=True)
    typ = item["type"]
    # Truncate the BASE before appending slug_suffix, so a disambiguating suffix
    # (e.g. a session hash) always survives — never sliced off by the length cap.
    base = re.sub(r"[^a-z0-9-]", "", item["slug"].lower().replace(" ", "-"))[:50]
    slug = f"{base}-{slug_suffix}" if slug_suffix else base
    fn = mem_dir / f"{typ}_{slug}.md"
    # Loop A (supersession at write time): the model may declare that this memory
    # replaces an existing one. Validate hard: an exact filename in THIS store
    # (same-store stage; cross-store pairs are Loop B's sweep, FM-A3), never the
    # file being written (a same-slug overwrite is version continuity, decision
    # D2). A bad target drops the claim with a WARN; it never fails the run.
    target = item.get("supersedes")
    if target is not None:
        target = str(target).strip()
        if target == fn.name:
            target = None
        elif not target or "/" in target or not (mem_dir / target).is_file():
            print(f"  WARN: supersedes={target!r} is not an existing file in {mem_dir.name}; "
                  f"writing {fn.name} without a supersession mark", file=sys.stderr)
            target = None
    supersedes_line = f"supersedes: {target}\n" if target else ""
    created = datetime.now(timezone.utc).astimezone().isoformat()
    src = f"  source_session: {source_session}\n" if source_session else ""
    # Persist the citations. A claim whose supporting span is on the file can be
    # re-checked without re-reading the whole transcript, which matters most once
    # the transcript itself has aged out of the local store.
    passages = [str(q) for q in (item.get("passages") or []) if str(q).strip()]
    if passages:
        src += "  passages:\n" + "".join(
            "    - " + json.dumps(q) + "\n" for q in passages)
    # Provenance: queryable attributes under metadata (matchesProvenance reads
    # metadata.* first). Partition key is project x persona; runtime+model are
    # attributes, never the key — so a persona's memory survives model/runtime swaps.
    prov = ""
    # tenant/principal are stamped from the start even though nothing enforces
    # scoping yet. The field is nearly free now; backfilling identity later is
    # impossible for any memory whose source transcript has already expired.
    for key in ("tenant", "principal", "runtime", "persona", "model", "extractor_model"):
        val = (provenance or {}).get(key)
        if val:
            prov += f"  {key}: {val}\n"
    for key in ("project", "feedback_kind"):
        if item.get(key) is not None:
            prov += f"  {key}: {json.dumps(item[key])}\n"
    if item.get("support"):
        # Write-time support check (Phase 5): do the cited passages back the memory?
        prov += f"  support: {item['support']}\n  support_check: {support_check.prompt_sha256()[:12]}\n"
    if any(item.get(key) is not None for key in ("project", "feedback_kind")):
        prov += "  scope_review: unreviewed\n"
    if item.get("assertions"):
        # Keep generated claims separate from curated top-level assertions and
        # memory-wide currency fields. Admission state lives in the candidates
        # table, not on the note (the assertion_review tag was dropped 2026-10-20).
        prov += f"  assertions: {json.dumps(item['assertions'], ensure_ascii=False)}\n"
    # Curated-key preservation: canonical/aliases (the Engram canonical layer)
    # and any other hand-added top-level frontmatter are curation the model
    # knows nothing about. A re-extraction of a grown session overwrites the
    # file (os.replace below) — on 2026-06-11 that silently stripped
    # canonical:true from the L01 gold memory and invalidated a Stage-B eval.
    # Parse the existing frontmatter (regex scraping missed column-0 aliases,
    # blank lines, and YAML comments — two review rounds, 2026-06-11) and carry
    # over every key write_memory doesn't itself regenerate.
    curated = ""
    if fn.exists():
        try:
            import frontmatter as _fmlib
            import yaml as _yaml
            old_meta = _fmlib.load(fn).metadata
            keep = {k: v for k, v in old_meta.items()
                    if k not in ("name", "description", "metadata", "created")
                    and not (k == "supersedes" and target)}
            if keep:
                curated = _yaml.safe_dump(keep, default_flow_style=False,
                                          sort_keys=False, allow_unicode=True)
        except Exception as e:
            print(f"  WARN: could not read existing {fn.name} for curated-key preservation: {e}", file=sys.stderr)
    fm = (
        f"---\nname: {slug}\n"
        f"{curated}"
        f"{supersedes_line}"
        f"description: {json.dumps(item['description'])}\n"
        f"metadata:\n  type: {typ}\n  source: extracted\n{prov}{src}"
        f"created: '{created}'\n---\n\n"
    )
    # Atomic write (tmp + replace): the 30-min vault mirror may read concurrently
    # during a long extraction run — never expose a torn/half-written file.
    tmp = fn.with_suffix(".md.tmp")
    tmp.write_text(fm + item["body"].strip() + "\n")
    os.replace(tmp, fn)
    if target:
        mark_superseded(mem_dir / target, fn.name)
    return fn


def source_model(jsonl: Path) -> str:
    """Best-effort: the model that produced this Claude Code session.
    Returns the last real assistant model stamped in the transcript, or ""."""
    try:
        model = ""
        for line in jsonl.read_text(errors="ignore").splitlines():
            m = re.search(r'"model"\s*:\s*"([^"]+)"', line)
            if m and m.group(1) not in ("<synthetic>",):
                model = m.group(1)
        return model
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Runtime adapters (2026-08-12). PRODUCT_SPEC.md:172 requires Claude Code,
# Codex, Hermes and OpenClaw as beta adapters; until now only Claude Code
# sessions were mined and everything else was archive-only. Each adapter yields
# "units" shaped so the shared extract_conv() path (guards, model call,
# routing, provenance, state) is identical for every runtime.
#
# A unit is a dict: {sid, runtime, label, mem_dir, mt, growth, load}
#   sid     - state.json key, runtime-prefixed ("codex:...") so ids never
#             collide with Claude Code stems
#   mt      - source mtime (epoch) for cutoff + re-extraction checks
#   growth  - line/message count analog for the touched-vs-grown check
#   load    - lazy () -> (conv, source_model); parsing is deferred so the
#             16k-file OpenClaw tree is only opened for new/changed sessions

from types import SimpleNamespace


def _conv(messages):
    return SimpleNamespace(messages=[SimpleNamespace(role=r, content=c) for r, c in messages])


def encode_project_dir(cwd: str) -> str:
    """Mirror Claude Code's project-dir encoding so all runtimes share one
    store per project (and one routing map) instead of growing new silos."""
    return re.sub(r"[^A-Za-z0-9-]", "-", cwd)


def _routed_mem_dir(cwd: str) -> Path | None:
    # Daemon sessions run from "/" or $HOME; those are not projects and must
    # not mint junk stores like PROJECTS/"-". Callers fall back per-runtime.
    if not cwd or cwd in ("/", str(Path.home())):
        return None
    encoded = encode_project_dir(cwd)
    if len(encoded) < 3 or any(s in encoded for s in EXCLUDED_PROJECT_SUBSTR):
        return None
    return canonical_memory_dir(PROJECTS / encoded)


CODEX_DIR = Path(INSTALL.get("CODEX_HOME", Path.home() / ".codex")) / "sessions"
# Codex frames instructions/environment as user messages; they are harness
# noise, not conversation.
CODEX_USER_NOISE = ("# agents.md instructions", "<permissions instructions",
                    "<environment_context", "<user_instructions", "<turn_context",
                    "<recommended_plugins")


def _codex_load(path: Path):
    meta, messages, model = {}, [], ""
    for line in path.read_text(errors="ignore").splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        t, p = d.get("type"), d.get("payload") or {}
        if t == "session_meta":
            meta = p
        elif t == "turn_context" and p.get("model"):
            model = p["model"]
        elif t == "response_item" and p.get("type") == "message":
            role = p.get("role")
            if role not in ("user", "assistant"):
                continue
            text = " ".join(c.get("text", "") for c in p.get("content") or []
                            if isinstance(c, dict) and c.get("text"))
            if role == "user" and any(text.lower().startswith(s) for s in CODEX_USER_NOISE):
                continue
            if text.strip():
                messages.append((role, text))
    return meta, _conv(messages), model


def codex_units():
    if not CODEX_DIR.is_dir():
        return
    for path in CODEX_DIR.rglob("rollout-*.jsonl"):
        st = path.stat()

        def load(path=path):
            meta, conv, model = _codex_load(path)
            if meta.get("thread_source") == "subagent":
                return None, None, None  # subagent thread: agent-to-agent, skip
            return _routed_mem_dir(meta.get("cwd", "")), conv, model

        yield {"sid": f"codex:{path.stem}", "runtime": "codex", "label": path.stem,
               "mt": st.st_mtime, "growth_path": path, "load": load}


HERMES_DB = Path.home() / ".hermes" / "state.db"
# The operator's Hermes checkout folder, encoded; an install has no Hermes state DB.
HERMES_MEM_DIR = PROJECTS / os.environ.get("ENGRAM_HERMES_MEMORY_SLUG", "-Users-jeremyshank-Projects-hermes-agent")


def hermes_units():
    if not HERMES_DB.exists():
        return
    import sqlite3
    db = sqlite3.connect(f"file:{HERMES_DB}?mode=ro", uri=True)
    try:
        rows = db.execute(
            "SELECT s.id, s.model, s.cwd, MAX(m.timestamp), COUNT(m.id) FROM sessions s "
            "JOIN messages m ON m.session_id = s.id "
            "WHERE s.source != 'cron' AND s.parent_session_id IS NULL "
            "GROUP BY s.id").fetchall()
    finally:
        db.close()
    for sid, model, cwd, mt, n_msgs in rows:
        def load(sid=sid, model=model, cwd=cwd):
            db = sqlite3.connect(f"file:{HERMES_DB}?mode=ro", uri=True)
            try:
                msgs = db.execute(
                    "SELECT role, content FROM messages WHERE session_id = ? "
                    "AND role IN ('user','assistant') AND content IS NOT NULL "
                    "ORDER BY timestamp", (sid,)).fetchall()
            finally:
                db.close()
            # Route by the session's working directory when Hermes recorded one,
            # so Hermes memories land in the same per-project stores as every
            # other runtime; cwd-less sessions go to the hermes-agent store.
            mem_dir = (_routed_mem_dir(cwd) if cwd else None) or canonical_memory_dir(HERMES_MEM_DIR)
            return (mem_dir,
                    _conv([(r, c) for r, c in msgs if (c or "").strip()]),
                    model or "")

        yield {"sid": f"hermes:{sid}", "runtime": "hermes", "label": f"hermes-{sid[:8]}",
               "mt": mt or 0, "growth": n_msgs, "load": load}


OPENCLAW_DIR = Path.home() / ".openclaw" / "agents"


def _openclaw_load(path: Path):
    cwd, messages, model = "", [], ""
    for line in path.read_text(errors="ignore").splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        t = d.get("type")
        if t == "session":
            cwd = d.get("cwd", "")
        elif t == "model_change":
            model = "/".join(x for x in (d.get("provider"), d.get("modelId")) if x)
        elif t == "message":
            m = d.get("message") or {}
            role = m.get("role")
            if role not in ("user", "assistant"):
                continue
            text = " ".join(c.get("text", "") for c in m.get("content") or []
                            if isinstance(c, dict) and c.get("text"))
            if text.strip():
                messages.append((role, text))
    return cwd, _conv(messages), model


def openclaw_units():
    if not OPENCLAW_DIR.is_dir():
        return
    for path in OPENCLAW_DIR.glob("*/sessions/*.jsonl"):
        if ".trajectory." in path.name:
            continue
        st = path.stat()

        def load(path=path):
            cwd, conv, model = _openclaw_load(path)
            return _routed_mem_dir(cwd), conv, model

        yield {"sid": f"openclaw:{path.stem}", "runtime": "openclaw", "label": path.stem,
               "mt": st.st_mtime, "growth_path": path, "load": load}


ADAPTERS = {"codex": codex_units, "hermes": hermes_units, "openclaw": openclaw_units}

# Sessions that predate adapter activation are recorded, not mined: a first run
# over months of Codex/OpenClaw history would be hundreds of model calls in one
# night, and consensus is no mass backfill (a re-extraction adds a correct
# memory beside a wrong one; supersession does not exist yet). Delete the
# state.json entry for a session to deliberately mine it later.
ADAPTER_BACKFILL_DAYS = int(os.environ.get("ENGRAM_ADAPTER_BACKFILL_DAYS", "14"))


def call_api(model, system, user_block):
    import anthropic
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=model,
        max_tokens=2000,
        system=[{"type": "text", "text": system,
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_block}],
    )
    return resp.content[0].text


# ---------------------------------------------------------------------------
# Bring-your-own-subscription backend (October 17, out-of-box plan Phase 2): the
# user's own logged-in `claude` or `codex` CLI. One driver per run, chosen by
# setting; no fallback between drivers or to any other backend. Each call runs
# from an empty temp directory, writes no session file (--no-session-persistence,
# --ephemeral) and loads none of the user's hooks, MCP servers or settings, so the
# extractor never sees or mines its own calls. Codex still reads the user's global
# AGENTS.md; passages are checked against the transcript, so it cannot add a claim.

CLI_DRIVERS = ("claude", "codex")
# The first user turn of an extraction call, for either driver. Sessions that open
# this way are the extractor's own calls and are never mined (cli backend only).
CLI_SELF_SIGNATURES = (SYSTEM_PROMPT.split("\n", 1)[0][:120].lower(), "existing memories for this project:")


def cli_response_schema() -> dict:
    """MEMORY_RESPONSE_SCHEMA under a top-level object, every field required (strict
    structured output needs both). supersedes becomes nullable; null means none."""
    import copy
    item = copy.deepcopy(MEMORY_RESPONSE_SCHEMA["items"])
    item["properties"]["supersedes"] = {"type": ["string", "null"]}
    item["required"] = list(item["properties"])
    return {"type": "object", "properties": {"memories": {"type": "array", "items": item}},
            "required": ["memories"], "additionalProperties": False}


class CliBackendError(RuntimeError):
    """The CLI call failed: not logged in, a limit, a bad model, or unusable output."""


def _cli_bin(driver: str) -> str:
    import shutil
    configured = os.environ.get(f"ENGRAM_{driver.upper()}_BIN")
    found = configured or shutil.which(driver)
    if not found:
        raise CliBackendError(f"{driver} CLI not found on PATH (set ENGRAM_{driver.upper()}_BIN)")
    return found


def run_cli(driver: str, model: str, system: str, user_block: str, timeout: int = 600):
    """One CLI call. Returns (returncode, stdout, stderr, last_message); never raises on a
    nonzero exit, so parse_cli_output() owns every failure decision."""
    import tempfile
    schema = cli_response_schema()
    with tempfile.TemporaryDirectory(prefix="engram-extract-") as work:
        if driver == "claude":
            cmd = [_cli_bin("claude"), "-p", "--no-session-persistence", "--output-format", "json",
                   "--json-schema", json.dumps(schema), "--system-prompt", system,
                   "--tools", "", "--setting-sources", "", "--strict-mcp-config"]
            stdin = user_block
        elif driver == "codex":
            schema_file = os.path.join(work, "schema.json")
            with open(schema_file, "w") as fh:
                json.dump(schema, fh)
            last = os.path.join(work, "last-message.json")
            # --ignore-user-config also drops the user's reasoning effort, and the fallback is
            # none (Gate 2 run 1, 2026-10-17: 7 of 10 sessions yielded memories). Set it.
            effort = os.environ.get("ENGRAM_CODEX_EFFORT", "high")
            cmd = [_cli_bin("codex"), "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
                   "--ignore-user-config", "--ignore-rules", "-c", f'model_reasoning_effort="{effort}"',
                   "--output-schema", schema_file, "-o", last]
            stdin = f"{system}\n\n{user_block}"
        else:
            raise CliBackendError(f"unknown cli driver {driver!r}; expected one of {CLI_DRIVERS}")
        if model:
            cmd += ["--model", model] if driver == "claude" else ["-m", model]
        if driver == "codex":
            cmd.append("-")
        env = dict(os.environ)
        cli_home = os.environ.get("ENGRAM_CLI_HOME")
        if cli_home:  # the home whose CLI logins to use, when it is not this process's HOME
            env.pop("CLAUDE_CONFIG_DIR", None)
            env.update(HOME=cli_home, CODEX_HOME=os.path.join(cli_home, ".codex"))
        try:
            got = subprocess.run(cmd, input=stdin, capture_output=True, text=True, cwd=work, timeout=timeout, env=env)
        except subprocess.TimeoutExpired as e:
            raise CliBackendError(f"{driver} CLI exceeded {timeout}s") from e
        last_message = None
        if driver == "codex" and os.path.exists(last):
            with open(last) as fh:
                last_message = fh.read()
        return got.returncode, got.stdout, got.stderr, last_message


def _tail(text: str, n: int = 300) -> str:
    return " ".join((text or "").split())[-n:]


def parse_cli_output(driver: str, returncode: int, stdout: str, stderr: str, last_message):
    """The memories array from one CLI call, or CliBackendError. Never a partial list."""
    if driver == "claude":
        try:
            wrapper = json.loads(stdout)
        except (TypeError, ValueError):
            raise CliBackendError(f"claude exit {returncode}: no JSON result ({_tail(stderr or stdout)!r})")
        if not isinstance(wrapper, dict):
            raise CliBackendError("claude result is not a JSON object")
        if returncode != 0 or wrapper.get("is_error") or wrapper.get("subtype") != "success":
            raise CliBackendError(f"claude exit {returncode}: {_tail(str(wrapper.get('result') or stderr))}")
        payload = wrapper.get("structured_output")
        if payload is None:
            try:
                payload = json.loads(wrapper.get("result") or "")
            except ValueError:
                raise CliBackendError("claude returned no structured output")
    elif driver == "codex":
        if returncode != 0:
            raise CliBackendError(f"codex exit {returncode}: {_tail(stderr)}")
        if not (last_message or "").strip():
            raise CliBackendError("codex returned an empty final message")
        try:
            payload = json.loads(last_message)
        except ValueError:
            raise CliBackendError(f"codex final message is not JSON: {_tail(last_message, 200)!r}")
    else:
        raise CliBackendError(f"unknown cli driver {driver!r}")
    if not isinstance(payload, dict) or not isinstance(payload.get("memories"), list):
        raise CliBackendError(f"{driver} output lacks a memories array")
    items = payload["memories"]
    for item in items:
        if isinstance(item, dict) and item.get("supersedes") is None:
            item.pop("supersedes", None)
    return items


def call_cli(driver, model, system, user_block, timeout=600):
    return parse_cli_output(driver, *run_cli(driver, model, system, user_block, timeout))


def cli_preflight(driver: str, model: str = "") -> None:
    """One tiny call before any session. Raises CliBackendError when the CLI cannot answer."""
    items = call_cli(driver, model, "You return JSON only.",
                     'Preflight. Return {"memories": []} and nothing else.', timeout=180)
    if items:
        raise CliBackendError(f"{driver} preflight returned {len(items)} memories, expected none")


def call_ollama(url, model, think, system, user_block, timeout=600, temperature=0.2,
                num_ctx=32768, num_predict=None, fmt=None):
    # Context overflow is SILENT and catastrophic here. Ollama truncates from the
    # front, which discards the system prompt, so the model stops being an extractor
    # and just continues the transcript in first person. Verified 2026-08-01 on
    # session 127a2f93: at num_ctx=32768 it returned "I'm actively polling Home
    # Assistant every 5 seconds..."; at 131072 the same model on the same input
    # returned correct JSON. size_request() sizes the window to the prompt and
    # raises rather than truncating; main() turns that into a retryable error.
    payload = {
        "model": model,
        "stream": False,
        "think": think,  # "low" | "medium" | "high"
        "options": {"temperature": temperature, "num_ctx": num_ctx},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_block},
        ],
    }
    # Optional, for callers that bound the reply (output counts against num_ctx)
    # or constrain it to a JSON schema; the extractor passes neither.
    if num_predict is not None:
        payload["options"]["num_predict"] = num_predict
    if fmt is not None:
        payload["format"] = fmt
    req = urllib.request.Request(
        f"{url}/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    # urlopen's socket timeout bounds a fully-wedged connection, but a slow-trickle
    # response can read past it indefinitely (the 21h-hung-run class). SIGALRM adds
    # a hard wall-clock ceiling. Main-thread only — signals can't arm off-thread;
    # there we fall back to the socket timeout alone. The deadline is generous
    # (2x the socket timeout) so it only fires on a genuine wedge, never a slow-but-
    # progressing call; the raised TimeoutError is caught per-session by the core.
    import signal, threading
    armed = threading.current_thread() is threading.main_thread()
    if armed:
        def _deadline(signum, frame):
            raise TimeoutError(f"ollama call exceeded {2 * timeout}s hard deadline")
        prev = signal.signal(signal.SIGALRM, _deadline)
        signal.alarm(2 * timeout)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
    finally:
        if armed:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, prev)
    return data.get("message", {}).get("content", "")


def call_openai(base_url, model, system, user_block, timeout=600, temperature=0.2,
                response_schema=None, response_name="response", max_tokens=None):
    """OpenAI-compatible chat-completions backend (e.g. the operator's gateway
    at http://127.0.0.1:8790/v1, where `model` is a lane id).
    Mirrors call_ollama's hard SIGALRM deadline so a slow-trickle frontier
    response can't hang past the wall-clock ceiling."""
    payload = {
        "model": model,
        "stream": False,
        "temperature": temperature,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_block},
        ],
    }
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    if response_schema is not None:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": response_name,
                "strict": True,
                "schema": response_schema,
            },
        }
    headers = {"Content-Type": "application/json"}
    bearer = os.environ.get("LEYLINE_TOKEN") or os.environ.get("OPENAI_API_KEY")
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload).encode(),
        headers=headers,
    )
    import signal, threading
    armed = threading.current_thread() is threading.main_thread()
    if armed:
        def _deadline(signum, frame):
            raise TimeoutError(f"openai call exceeded {2 * timeout}s hard deadline")
        prev = signal.signal(signal.SIGALRM, _deadline)
        signal.alarm(2 * timeout)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
    finally:
        if armed:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, prev)
    return data["choices"][0]["message"]["content"]


def extract_session(cfg, jsonl: Path, mem_dir: Path, dry: bool):  # branch-divergence: intentional — guard clauses below each `return 0, []` (session skipped, no memory written); cfg/dry/mem_dir legitimately N/A on early-exit paths
    convs = ClaudeCodeHistoryParser().parse(jsonl)
    if not convs:
        return 0, []
    return extract_conv(cfg, convs[0], jsonl.stem, mem_dir, source_model(jsonl),
                        cfg.get("runtime", "claude-code"), dry)


def extract_conv(cfg, conv, session_id, mem_dir, model_hint, runtime, dry):  # branch-divergence: intentional — same guard-clause shape as extract_session: each `return 0, []` is a skipped session, params legitimately N/A
    # The cli backend also refuses its own extraction calls, should one ever be persisted.
    if (is_agent_session(conv, CLI_SELF_SIGNATURES) if cfg["backend"] == "cli" else is_agent_session(conv)):
        return 0, []  # automated agent/heartbeat run — skip, no model call
    transcript = build_transcript(conv, envelopes=False) if cfg["backend"] == "cli" else build_transcript(conv)
    if len(transcript) < 200:
        return 0, []
    user_block = (
        f"EXISTING MEMORIES FOR THIS PROJECT:\n{existing_memory_context(mem_dir)}\n\n"
        f"SESSION TRANSCRIPT:\n{transcript}"
    )
    if cfg["backend"] == "ollama":
        nctx, tmo, est = size_request(SYSTEM_PROMPT, user_block,
                                      cfg.get("num_ctx", 32768))
        print(f"    {session_id[:8]}: ~{est:,.0f} tok -> num_ctx={nctx:,} timeout={tmo}s",
              flush=True)
        raw = call_ollama(cfg["ollama_url"], cfg["model"], cfg["think"],
                          SYSTEM_PROMPT, user_block, timeout=tmo, num_ctx=nctx)
    elif cfg["backend"] == "openai":
        raw = call_openai(cfg.get("base_url", "http://127.0.0.1:8790/v1"),
                          cfg["model"], SYSTEM_PROMPT, user_block,
                          response_schema=MEMORY_RESPONSE_SCHEMA,
                          response_name="engram_memories")
    elif cfg["backend"] == "cli":
        raw = None
        # One retry in the same run when a reply fails validation (a passage that is not
        # verbatim, a bad field). The hourly job would retry the session next hour anyway;
        # a second failure fails the session loudly. CLI errors are never retried here.
        system = SYSTEM_PROMPT + "\n\n" + CODEX_READING_NOTE if cfg["cli_driver"] == "codex" else SYSTEM_PROMPT
        for attempt in (1, 2):
            items = call_cli(cfg["cli_driver"], cfg.get("cli_model", ""), system, user_block)
            try:
                validate_items(items, transcript)
                raw = json.dumps(items)
                break
            except ValueError as e:
                if attempt == 2:
                    raise
                print(f"  WARN {session_id[:8]}: reply failed validation ({e}); retrying once", file=sys.stderr)
    else:
        raw = call_api(cfg["model"], SYSTEM_PROMPT, user_block)
    raw = (raw or "").strip()
    # gpt-oss may wrap JSON in prose/code fences; grab the array
    raw = re.sub(r"^```(json)?|```$", "", raw, flags=re.M).strip()
    arr = re.search(r"\[.*\]", raw, flags=re.S)
    if arr:
        raw = arr.group(0)
    # A model that returns unparseable output is a FAILURE, not an empty result.
    # Returning (0, []) here used to let main() stamp state.json for the session,
    # permanently retiring it unextracted. Raise instead, so it takes the same
    # retry path as an API error and gets picked up on the next run.
    try:
        items = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"model returned unparseable JSON ({e}); first 200 chars: {raw[:200]!r}")
    if not isinstance(items, list):
        raise ValueError(f"model returned {type(items).__name__}, expected a JSON array")
    validate_items(items, transcript)
    if cfg["backend"] == "openai" and os.environ.get("ENGRAM_SUPPORT_CHECK", "1") != "0" and not dry:
        # The judge that qualified on docs/SUPPORT_JUDGE_GATE_2026-10-15.json, on the same lane.
        base_url = cfg.get("base_url", "http://127.0.0.1:8790/v1")
        chat = lambda system, user: call_openai(base_url, cfg["model"], system, user, timeout=180,
                                                temperature=0.0)
        for it in items:
            it["support"] = support_check.check(chat, it["description"], it["body"], it["passages"])
    prov = {
        "extractor_model": cfg.get("model", ""),
        "runtime": runtime,
        "persona": cfg.get("persona", PERSONA),
        "model": model_hint,
        # Must match the KG runtime identity (~/.config/engram/tenant.env) so
        # memories and the tenant-scoped kg.db share one identity namespace.
        "tenant": os.environ.get("ENGRAM_TENANT_ID", "jeremy"),
        "principal": os.environ.get("ENGRAM_PRINCIPAL_ID", "jeremy"),
    }
    written = []
    for it in items:
        if dry:
            sup = f"  supersedes={it['supersedes']}" if it.get("supersedes") else ""
            written.append(f"[{it['type']}] {it['slug']}: {it['description']}{sup}")
        else:
            written.append(str(write_memory(
                mem_dir, it, source_session=session_id, provenance=prov)))
    return len(written), written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--project", default="")
    ap.add_argument("--since-days", type=int, default=0)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--runtime", default="claude-code",
                    help="provenance: runtime that produced the sessions")
    ap.add_argument("--runtimes", default="claude-code",
                    help="comma list of session sources to mine: claude-code plus any of "
                         "codex, hermes, openclaw. Adapters whose source dirs are absent "
                         "on this machine are silently skipped, so one value works on "
                         "both laptop and mini.")
    ap.add_argument("--persona", default=PERSONA,
                    help="provenance: persona/identity owning these memories")
    ap.add_argument("--backend", choices=["api", "ollama", "openai", "cli"], default="api",
                    help="cli: the user's logged-in claude or codex CLI, named by ENGRAM_CLI_DRIVER "
                         "(env, then engram.env); no fallback between drivers")
    ap.add_argument("--think", choices=["low", "medium", "high"], default="high")
    ap.add_argument("--ollama-url", default="http://localhost:11434")
    ap.add_argument("--num-ctx", type=int, default=131072,
                    help="CAP on the ollama context window. The actual window is sized "
                         "per session by size_request(); a prompt needing more than this "
                         "is refused rather than silently truncated.")
    ap.add_argument("--base-url", default="http://127.0.0.1:8790/v1",
                    help="OpenAI-compatible base URL for --backend openai (default: the operator gateway)")
    args = ap.parse_args()

    if args.backend == "api" and not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY not set", file=sys.stderr)
        return 1
    if args.backend == "ollama" and args.model == DEFAULT_MODEL:
        args.model = "gpt-oss:20b"
    cli_model = ""
    cli_driver = os.environ.get("ENGRAM_CLI_DRIVER") or INSTALL.get("ENGRAM_CLI_DRIVER")
    if args.backend == "cli":
        if cli_driver not in CLI_DRIVERS:
            print(f"--backend cli needs ENGRAM_CLI_DRIVER set to one of {CLI_DRIVERS}, got {cli_driver!r}",
                  file=sys.stderr)
            return 64
        # DEFAULT_MODEL is an API model id; the CLI picks its own unless one is named.
        cli_model = "" if args.model == DEFAULT_MODEL else args.model
        args.model = f"cli/{cli_driver}" + (f"/{cli_model}" if cli_model else "")
        try:
            cli_preflight(cli_driver, cli_model)
        except CliBackendError as e:
            print(f"ERROR: {cli_driver} preflight failed, nothing extracted: {e}", file=sys.stderr)
            return 5
    cfg = {"backend": args.backend, "model": args.model,
           "cli_driver": cli_driver, "cli_model": cli_model,
           "think": args.think, "ollama_url": args.ollama_url, "base_url": args.base_url,
           "num_ctx": args.num_ctx,
           "runtime": args.runtime, "persona": args.persona}
    state = load_state()

    cutoff = None
    if args.since_days:
        cutoff = (datetime.now() - timedelta(days=args.since_days)).timestamp()

    sessions = []
    for proj in sorted(PROJECTS.iterdir()):
        if args.project and args.project not in proj.name:
            continue
        if project_dir_excluded(proj.name):
            continue
        for jsonl in proj.glob("*.jsonl"):
            mt = jsonl.stat().st_mtime
            if cutoff and mt < cutoff:
                continue
            sid = jsonl.stem
            prev = state.get(sid)
            if prev and prev.get("mtime", 0) >= mt:
                continue
            # mtime is newer — but a touched file is not a grown session. On
            # 2026-06-10 a one-shot sweep re-touched ~60 old transcripts and
            # the next run re-mined them all (179 overwrites). Confirm growth
            # by line count before paying for an extraction; if unchanged,
            # just refresh the stored mtime.
            if prev and "line_count" in prev:
                try:
                    with open(jsonl, "rb") as fh:
                        lc = sum(1 for _ in fh)
                    if lc == prev["line_count"]:
                        state[sid] = {**prev, "mtime": mt}
                        save_state(state)
                        continue
                except OSError:
                    pass  # unreadable — fall through and let extraction decide
            sessions.append((jsonl, canonical_memory_dir(proj), mt))

    sessions.sort(key=lambda x: x[2], reverse=True)
    if args.limit:
        sessions = sessions[: args.limit]

    total_mem = 0
    errors = 0
    for jsonl, mem_dir, mt in sessions:
        try:
            n, written = extract_session(cfg, jsonl, mem_dir, args.dry_run)
        except Exception as e:
            errors += 1
            print(f"ERROR {jsonl.name}: {e}", file=sys.stderr)
            continue
        total_mem += n
        if n:
            tag = "[dry] " if args.dry_run else ""
            print(f"{tag}{jsonl.parent.name} / {jsonl.stem[:8]}: {n} memories")
            for w in written:
                print(f"    {w}")
        if not args.dry_run:
            try:
                with open(jsonl, "rb") as fh:
                    line_count = sum(1 for _ in fh)
            except OSError:
                line_count = None
            state[jsonl.stem] = {"mtime": mt, "line_count": line_count, "extracted_at": datetime.now().isoformat()}
            save_state(state)

    # --- non-Claude runtimes (codex / hermes / openclaw adapters) ---
    adapter_units = []
    backfill_cutoff = (datetime.now() - timedelta(days=ADAPTER_BACKFILL_DAYS)).timestamp()
    for rt in [r.strip() for r in args.runtimes.split(",") if r.strip()]:
        gen = ADAPTERS.get(rt)
        if not gen:
            continue
        for unit in gen() or []:
            mt = unit["mt"]
            if cutoff and mt < cutoff:
                continue
            prev = state.get(unit["sid"])
            if prev and prev.get("mtime", 0) >= mt:
                continue
            if prev and prev.get("line_count") is not None:
                # touched-vs-grown check, same rationale as the Claude path
                growth = unit.get("growth")
                if growth is None and "growth_path" in unit:
                    try:
                        with open(unit["growth_path"], "rb") as fh:
                            growth = sum(1 for _ in fh)
                    except OSError:
                        growth = None
                if growth is not None and growth == prev["line_count"]:
                    state[unit["sid"]] = {**prev, "mtime": mt}
                    continue
            if not prev and mt < backfill_cutoff:
                # history predating adapter activation: record, don't mine
                state[unit["sid"]] = {"mtime": mt, "skipped": "pre-adapter-backfill",
                                      "noted_at": datetime.now().isoformat()}
                continue
            adapter_units.append(unit)
    if not args.dry_run:
        save_state(state)  # persist backfill stamps and mtime refreshes

    adapter_units.sort(key=lambda u: u["mt"], reverse=True)
    if args.limit:
        adapter_units = adapter_units[: max(0, args.limit - len(sessions))]
    for unit in adapter_units:
        try:
            mem_dir, conv, src_model = unit["load"]()
            if mem_dir is None or conv is None or not conv.messages:
                n, written = 0, []  # subagent thread / excluded project / empty
            else:
                n, written = extract_conv(cfg, conv, unit["sid"], mem_dir,
                                          src_model, unit["runtime"], args.dry_run)
        except Exception as e:
            errors += 1
            print(f"ERROR {unit['sid']}: {e}", file=sys.stderr)
            continue
        total_mem += n
        if n:
            tag = "[dry] " if args.dry_run else ""
            print(f"{tag}{unit['runtime']} / {unit['label'][:48]}: {n} memories")
            for w in written:
                print(f"    {w}")
        if not args.dry_run:
            growth = unit.get("growth")
            if growth is None and "growth_path" in unit:
                try:
                    with open(unit["growth_path"], "rb") as fh:
                        growth = sum(1 for _ in fh)
                except OSError:
                    growth = None
            state[unit["sid"]] = {"mtime": unit["mt"], "line_count": growth,
                                  "extracted_at": datetime.now().isoformat()}
            save_state(state)

    n_sessions = len(sessions) + len(adapter_units)
    print(f"\n{'[dry-run] ' if args.dry_run else ''}sessions={n_sessions} "
          f"memories={total_mem} errors={errors}")

    # Exit 0 on a genuinely quiet run (sessions processed, nothing qualified) but
    # NONZERO when work was attempted, nothing came out, and something errored.
    # That is the signature of the 2026-07-24 outage: 45 sessions, 45 API errors,
    # memories=0, exit 0 — launchd reported success for 178h. The EXIT trap in
    # run-memory-extraction.sh turns a nonzero exit into a Discord alert that night.
    if n_sessions and total_mem == 0 and errors:
        print(f"FATAL: {errors}/{len(sessions)} sessions errored and 0 memories were "
              f"extracted — treating as a failed run", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
