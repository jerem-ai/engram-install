# Install Engram on your Mac

Engram gives Claude Code and Codex a memory that lives on your computer. Once a
session ends, Engram reads it, writes down anything worth remembering (decisions,
preferences, gotchas), and brings the relevant notes back into later sessions in
either app. The memory is plain Markdown in `~/Engram/vault`. You can read it,
edit it, or open it in Obsidian.

It runs on your own Claude or Codex login. It sends nothing anywhere else. Each
session it reads is one request on that login, so it starts with your last 7 days of
sessions, not your whole history. Change `ENGRAM_SINCE_DAYS` in
`~/.config/engram/engram.env` to reach further back (empty means everything).

## What you need

- A Mac.
- Claude Code, logged in (run `claude`, then type `/login`). Codex works too, but
  Engram learns less from it today.
- Node 22, Python 3.12 and git. If one is missing, the installer stops and prints the
  Homebrew command for it.

## Paste this into Claude Code (or Codex)

```text
Install Engram for me from GitHub and check that it works:

1. Run: git clone https://github.com/jerem-ai/engram-install.git ~/Engram/src
2. Run: ~/Engram/src/scripts/install-local.sh
   If it stops because Node 22, Python 3.12 or git is missing, run the brew command it
   prints, then run the installer again. If it says Claude Code is not logged in, tell
   me to log in and stop.
3. Run: ~/Engram/current/scripts/engram-status.sh
   Show me its output. A brand-new install shows "extraction has not run yet" and no
   memories; that is expected. Anything marked FIX that is not about extraction or
   memories is a problem: show me its fix line.
4. Tell me to quit and reopen Claude Code (and Codex, if I use it) so the Engram tools
   and recall hook load.

Do not change any other settings.
```

## What the installer sets up

| What | Where |
|---|---|
| The program | `~/Engram/releases/<version>`, with `~/Engram/current` pointing at the live one |
| Your memory notes | `~/Engram/vault/Memory` |
| The search index | `~/Engram/data` |
| Settings | `~/.config/engram/engram.env` and `tenant.env` |
| Background jobs | `~/Library/LaunchAgents/com.engram.local.*`: learn from sessions hourly, copy notes into the vault and index them every 15 minutes, and a small search server on 127.0.0.1 |
| Claude Code and Codex | an `engram` MCP server (`engram_recall`, `engram_remember` and three read tools) and a recall hook that adds relevant notes to each prompt |
| Logs | `~/Engram/logs` |

## Check on it

```bash
~/Engram/current/scripts/engram-status.sh
```

Each line is OK, WARN or FIX, and every FIX line says what to run.

## Update

```bash
git -C ~/Engram/src pull && ~/Engram/src/scripts/install-local.sh
```

The previous version stays in `~/Engram/previous`.

## Remove it

```bash
~/Engram/src/scripts/install-local.sh --uninstall   # keeps your notes, index and settings
~/Engram/src/scripts/install-local.sh --purge       # removes those too
```

Add `--dry-run` to either to see what it would do first.
