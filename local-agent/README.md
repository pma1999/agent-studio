# Agent Studio — Local Agent

A standalone console application you run on your own Windows PC. Once paired,
it gives Agent Studio a persistent connection to run commands on this machine
— your real files, your real installed tools — instead of (or alongside) the
sandboxed cloud backend.

**Read this before pairing:** this agent runs commands with the same
permissions as the Windows account you run it under. The workspace folder you
choose during pairing is a convenience default, not a security sandbox. The
pairing flow shows the full explanation and requires you to type `yes` to
continue — read it.

## Prerequisites

- Windows, Node.js `>=20.19.0`.
- A running Agent Studio backend you can reach from this machine (a local dev
  server at `http://localhost:3001` by default, or your deployed instance's
  URL).

## Setup

```bash
cd local-agent
npm install
npm run build
npm start
```

(`npm run dev` runs directly from TypeScript via `tsx`, without a build step —
useful while developing this component itself.)

## First run: pairing

The first time you run it (no local config file yet), you'll be walked
through:

1. **Backend URL** — where your Agent Studio server lives.
2. **Workspace root directory** — the folder commands run in by default.
3. **Device name** — anything memorable; shown in Agent Studio's paired
   devices list.
4. **Pairing code** — open Agent Studio in your browser, go to
   **Settings -> Local Agent**, and click "Pair a new device" to get an
   8-character code (valid for 10 minutes, single-use). Type or paste it here.
5. **The security warning** — read it, then type `yes` to continue. Anything
   else cancels pairing and nothing is saved.

Once paired, the agent token and your chosen workspace root are saved locally
so future runs reconnect automatically — you won't see this flow again unless
the config file is deleted or moved.

## Where the config lives

`%APPDATA%\agent-studio-local-agent\config.json`

It holds the backend URL, your paired agent token, the workspace root, and
`allowOutsideWorkspace` (see below). Treat the token like a password — anyone
with it can run commands on this machine through your Agent Studio account.
Delete the file (or revoke the pairing from Agent Studio's settings UI) to
disconnect this device.

## Widening scope

By default, commands are rejected if their working directory resolves outside
the workspace root, and a small set of recognizably destructive commands
(recursive delete/force-remove outside the workspace root, `git push --force`,
registry deletes, shutdown/restart) require you to confirm them at this
console before they run.

This restriction is local and can only be changed **on this machine, by
editing the config file** — never remotely. To allow commands whose working
directory resolves outside the workspace root, open
`%APPDATA%\agent-studio-local-agent\config.json` and set:

```json
"allowOutsideWorkspace": true
```

then restart the agent. Tier-1 commands (fork bombs, disk format, `diskpart`,
`mkfs`, raw-disk writes) are always blocked regardless of this setting — there
is no override for those.

## How commands are run

At startup, the agent detects the best available shell on this machine, once,
and reuses that choice for every command until it is restarted (it never
re-detects per command or per reconnect). Preference order:

- **Windows**: `pwsh` (PowerShell 7+) -> `powershell` (Windows PowerShell
  5.1) -> `cmd.exe` (last resort, always present).
- **macOS/Linux** (future): `bash` -> `sh` (last resort, always present).

When PowerShell is used, the command text is passed via PowerShell's
`-EncodedCommand` flag (a base64-encoded form) rather than `-Command`. This is
purely a robustness detail of how this process invokes the shell —
`-EncodedCommand` sidesteps known quoting/parsing quirks in PowerShell's own
front-end argument parser (particularly in `powershell.exe` 5.1) that plain
`-Command` text can hit with embedded quotes or newlines. The model you're
talking to only ever sees the plain command text; it never sees, and does not
need to think about, this encoding.

Agent Studio discloses which shell this agent detected (and this machine's
platform) to the model dynamically each turn, so the model can tailor the
commands it generates accordingly — see the relevant server-side task's notes
for how that disclosure is built; it is not duplicated here.

## File tools (read_file, write_file, edit_file, delete_file, list_directory)

Besides `run_command`, Agent Studio can ask this agent to read, write, edit,
delete, and list files directly. These follow the same workspace-root
scoping as commands above: a path is resolved against the workspace root by
default, and rejected outright if it resolves outside that root and
`allowOutsideWorkspace` is not enabled. As with everything else in this
document, that scoping is a convenience default, not a security sandbox — an
absolute path, or `allowOutsideWorkspace: true`, can always reach outside it.

**Read-before-write/edit.** `write_file` refuses to overwrite a file that
already exists, and `edit_file` refuses to touch any existing file at all,
unless that exact path has already been read (via `read_file`, or a prior
successful write/edit to it) earlier in the same conversation. Creating a
brand-new file with `write_file` never needs a prior read.

**Delete confirmation.** Deleting a directory requires `recursive:true`
(deleting a single file never does). Beyond that, three tiers apply, in this
order:
1. A delete entirely inside the workspace root, non-recursive or a small
   recursive directory, runs immediately — no prompt.
2. A delete that resolves outside the workspace root (only possible at all
   with `allowOutsideWorkspace` enabled, per above), or a recursive directory
   delete estimated at more than 50 files or 50MB, pauses and asks you to
   confirm at this same console — the identical prompt `run_command`'s
   destructive-command guard already uses.
3. Anything hard-blocked by the workspace-root check above is never
   confirmable; it is rejected outright, the same as an out-of-root `cwd` for
   `run_command`.

## What this is not

This is a seatbelt, not a sandbox. There is no OS-level confinement (no
low-privilege account, no container, no Job Object limits) under the
workspace-root scoping or the destructive-command blocklist in v1 — both are
best-effort checks, not a guarantee. See the security warning shown at
pairing time for the full picture.
