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
- Node 22, Python 3.12 and git. You don't need them yet: your agent installs them with
  Homebrew. If Homebrew isn't on your Mac, your agent gives you one line to paste into
  the Terminal app, because installing it asks for your Mac password.

## Paste this into Claude Code (or Codex)

```text
Install Engram for me from GitHub and check that it works:

1. Check for Homebrew: ls /opt/homebrew/bin/brew /usr/local/bin/brew
   If neither exists, stop and tell me to open the Terminal app, paste this line, press
   Return and type my Mac password when it asks (the screen shows nothing as I type):
     /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   Tell me to come back and say "done" when it finishes. Then check again.
2. Install the tools with the brew that exists, by its full path (it may not be on
   PATH yet): <full path to brew> install git node@22 python@3.12
   If brew says it cannot write to its folder (another account on this Mac owns
   Homebrew), check <Homebrew folder>/opt for git, node@22 and python@3.12. If all
   three are there, carry on. If one is missing, tell me to ask whoever set up
   Homebrew to run the same brew install line, and stop.
3. Run, with the git from that same Homebrew folder:
   <Homebrew folder>/bin/git clone https://github.com/jerem-ai/engram-install.git ~/Engram/src
4. Run: ~/Engram/src/scripts/install-local.sh
   If it stops and prints a command to install something, run that command, then run
   the installer again. If it says Claude Code is not logged in, tell me to log in and
   stop.
5. Run: ~/Engram/current/scripts/engram-status.sh
   Show me its output. A brand-new install shows "extraction has not run yet" and no
   memories; that is expected. Anything marked FIX that is not about extraction or
   memories is a problem: show me its fix line.
6. Tell me to quit and reopen Claude Code (and Codex, if I use it) so the Engram tools
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
| Copies of your sessions | `~/Engram/archive`: a compressed copy of each Claude Code and Codex session, so a note can still show where it came from after Claude Code deletes old sessions (about 30 days) |
| Logs | `~/Engram/logs` |

## Check on it

```bash
~/Engram/current/scripts/engram-status.sh
```

Each line is OK, WARN or FIX, and every FIX line says what to run.

## Session copies

Every hour Engram copies new Claude Code and Codex sessions (including ChatGPT
desktop Work threads, which Codex writes) into `~/Engram/archive`. Only your user
account can read it. It only adds: a session Claude Code deletes stays in the copy.
`engram-status.sh` ends with a line showing its size.

To stop copying, install with `--no-archive`, or set `ENGRAM_ARCHIVE_DIR=off` in
`~/.config/engram/engram.env`. An update keeps that choice. To stop copying and delete
the copies:

```bash
~/Engram/src/scripts/install-local.sh --delete-archive
```

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

## Credits

Engram began as a fork of Jesse Vincent's
[knowledge-graph](https://github.com/obra/knowledge-graph) (MIT). Its vault index,
link parsing and graph queries still descend from that code.
