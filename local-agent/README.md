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

## What this is not

This is a seatbelt, not a sandbox. There is no OS-level confinement (no
low-privilege account, no container, no Job Object limits) under the
workspace-root scoping or the destructive-command blocklist in v1 — both are
best-effort checks, not a guarantee. See the security warning shown at
pairing time for the full picture.
