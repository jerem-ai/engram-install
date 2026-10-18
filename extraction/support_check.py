"""Support check on write (roadmap Phase 5, October 15).

One question per memory: do the memory's cited transcript passages back what the
memory says? The extractor already proves each passage is a verbatim transcript
substring; that proves the quote exists, not that it supports the claim. This
module holds the judge prompt, the rendering and the parser, shared by the
extractor (`extract-memories.py`) and its qualification harness
(`eval/support_judge.py`), so the prompt that qualified is the prompt that runs.

The verdict is an unreviewed annotation. `unsupported` keeps the memory on disk
and holds its typed claims out of self-admission; it never deletes anything.
"""
import hashlib
import json
import re

ANSWERS = ("supported", "unsupported")
MAX_BODY = 4000
MAX_PASSAGE = 1500

SYSTEM = """You check whether a stored memory is backed by the transcript passages cited as its evidence.

You receive one MEMORY (a one-line description and a body) and the PASSAGES the memory cites. Each passage is an exact quote from the conversation it was written from. "User:" passages are the person; other passages may be the assistant.

Question: Do the passages back what the memory claims?

Answer "supported" when the passages state or directly show the memory's central claim: the decision, rule, preference, fact or state it records. Paraphrase, summary and reasonable compression are fine, and so is a "why" or "how to apply" line that follows from the passages. The claim may use few of the passages' words.

Answer "unsupported" when the passages do not show the central claim: they are about something else; they state a different value, name, number, version or outcome than the memory does; they show the opposite; or they show only an assistant proposal or suggestion that the memory records as a settled decision or fact.

Judge only from what is shown. Do not use outside knowledge of the projects.

Return STRICT JSON only, no prose outside it:
{"answer":"supported"|"unsupported","reason":"one sentence"}"""


def prompt_sha256() -> str:
    return hashlib.sha256(SYSTEM.encode()).hexdigest()


def render(description: str, body: str, passages: list[str]) -> str:
    out = ["MEMORY:", f"Description: {description.strip()}", "", body.strip()[:MAX_BODY], "", "PASSAGES:"]
    out += [f"{i}. {p.strip()[:MAX_PASSAGE]}" for i, p in enumerate(passages, 1)]
    return "\n".join(out)


def parse(raw: str) -> tuple[str, str]:
    text = re.sub(r"^```(json)?|```$", "", (raw or "").strip(), flags=re.M).strip()
    m = re.search(r"\{.*\}", text, flags=re.S)
    if not m:
        raise ValueError("no JSON object in support judge output")
    obj = json.loads(m.group(0))
    answer = str(obj.get("answer", "")).strip().lower()
    if answer not in ANSWERS:
        raise ValueError(f"support answer {answer!r} is not one of {ANSWERS}")
    return answer, str(obj.get("reason", "")).strip()


def check(chat, description: str, body: str, passages: list[str], attempts: int = 2) -> str:
    """Return supported, unsupported or unchecked. `chat(system, user) -> str` is the extractor's
    own model call. A lane failure never blocks a write: the memory is written `unchecked`."""
    for _ in range(attempts):
        try:
            return parse(chat(SYSTEM, render(description, body, passages)))[0]
        except Exception:  # branch-divergence: intentional — any judge failure degrades to unchecked
            continue
    return "unchecked"
