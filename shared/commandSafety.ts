/**
 * Best-effort, regex-based command-safety classification for `run_command`
 * and MCP `stdio` command spawning.
 *
 * This is a best-effort pattern match, NOT a sandbox. It is a seatbelt, not
 * real OS-level isolation: absolute paths phrased differently than the
 * patterns below, indirection through a script file (`bash foo.sh`,
 * `powershell -File x.ps1`), or basic obfuscation (string concatenation,
 * alternate casing/encoding, unusual whitespace) can all bypass it. This is a
 * known, accepted limitation for v1, not silently implied to be more than it
 * is — do not present this module's verdicts as a guarantee of safety to
 * users or as a substitute for real sandboxing (E2B) when the destructive
 * potential of a workload matters.
 *
 * Zero-dependency by design: Node built-ins only (`node:path`). No imports
 * from `server/` or `src/` so both the backend (`server/mcp/client.ts`
 * hardening) and the separate `local-agent/` project can import this module
 * via relative path without pulling in Express/DB/React.
 */

import path from 'node:path';

export type SafetyTier = 0 | 1 | 2;

export interface SafetyVerdict {
  tier: SafetyTier;
  /** Human-readable pattern name, present when tier is 1 or 2. */
  label?: string;
}

interface TierPattern {
  regex: RegExp;
  label: string;
}

// --- Tier 1: hard block, case-insensitive, never remotely overridable. ---
const TIER1_PATTERNS: TierPattern[] = [
  { regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, label: 'fork-bomb' },
  { regex: /\bformat\s+[a-z]:/i, label: 'disk-format' },
  { regex: /\bdiskpart\b/i, label: 'diskpart' },
  { regex: /\bmkfs(\.\w+)?\b/i, label: 'mkfs' },
  { regex: /\bdd\b[^\n]*\bof=\/dev\//i, label: 'raw-disk-write' },
];

// --- Tier 2: require local human confirmation. ---
// Patterns whose escalation to tier 2 depends on whether the affected path
// resolves outside `workspaceRoot` (see resolvesOutsideWorkspace below).
const RECURSIVE_DELETE_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\b/i,
  /\bremove-item\b[^\n]*-recurse[^\n]*-force/i,
  /\bremove-item\b[^\n]*-force[^\n]*-recurse/i,
  /\brd\s+\/s\s+\/q\b/i,
];

// Always tier 2 regardless of workspaceRoot — these are not workspace-scoped
// concerns (they don't operate on "a path"), so allowOutsideWorkspace has no
// effect on them.
const FORCE_PUSH_PATTERN = /\bgit\s+push\b[^\n]*(--force\b|-f\b)/i;
const REGISTRY_DELETE_PATTERNS: RegExp[] = [
  /\breg\s+delete\b/i,
  /\bremove-item\b[^\n]*HKLM:/i,
  /\bremove-item\b[^\n]*HKCU:/i,
];
const POWER_CONTROL_PATTERNS: RegExp[] = [
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bstop-computer\b/i,
];

// Write/delete-shaped verbs used by the "scope-broadening" check.
const WRITE_DELETE_VERB = /\b(del|rm|remove-item|move|mv|set-content)\b|>>?/i;
// A token is absolute-path-shaped only when the path characters *start* the
// token (not merely appear as a substring, e.g. the "/build" inside
// "./build" must not count as an absolute path).
const ABSOLUTE_PATH_TOKEN_START = /^(?:[A-Za-z]:\\|\/)/;

/** Flag-like tokens excluded when extracting a candidate target path. */
function isFlagToken(token: string): boolean {
  if (token.startsWith('-')) return true;
  // Windows-style short flags, e.g. `/s`, `/q`, `/r`, `/t`, `/f` — a single
  // letter after the slash. Longer POSIX-looking paths (more than one
  // segment or more than one character) are not treated as flags.
  if (/^\/[A-Za-z]$/.test(token)) return true;
  return false;
}

/**
 * Best-effort extraction of "the target path" from a raw command string: the
 * last whitespace-separated, non-flag token. This is intentionally simple —
 * not a shell-argument parser — per the documented limitation above.
 */
function extractCandidatePath(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (!token || isFlagToken(token)) continue;
    // Skip the leading command/verb tokens themselves.
    if (/^(rm|rd|del|move|mv|remove-item|set-content|dd|format|diskpart|mkfs(\.\w+)?|reg|delete|shutdown|restart-computer|stop-computer|git|push)$/i.test(token)) {
      continue;
    }
    return token;
  }
  return null;
}

/** True when `p` is a Windows absolute path (drive-letter prefix). */
function isWindowsAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}

export function isPathWithinRoot(candidatePath: string, root: string): boolean {
  const rootIsWindows = isWindowsAbsolutePath(root);
  const candidateIsWindows = isWindowsAbsolutePath(candidatePath);
  if (candidateIsWindows && !rootIsWindows) {
    // Path-flavor mismatch: a Windows-absolute target against a POSIX root can
    // never be "inside" that root on any host. Be conservative.
    return false;
  }
  // On POSIX hosts the native `path` module would treat a Windows drive path
  // (`C:\...`) as a *relative* path, silently resolving everything "inside"
  // the root — which defeats the recursive-delete guard. Use win32 semantics
  // whenever the root is a Windows path. On Windows hosts `path.win32` is the
  // same module as `path`, so this is a no-op there.
  const p = rootIsWindows ? path.win32 : path;
  const resolvedRoot = p.resolve(root);
  const resolvedCandidate = p.resolve(resolvedRoot, candidatePath);
  const rel = p.relative(resolvedRoot, resolvedCandidate);
  if (rel === '') return true;
  return !rel.startsWith('..') && !p.isAbsolute(rel);
}

/**
 * True when the command's best-effort-extracted target path resolves
 * outside `workspaceRoot`, or when `workspaceRoot` is null (unknown root
 * means we cannot vouch for safety, so treat as outside).
 */
function resolvesOutsideWorkspace(command: string, workspaceRoot: string | null): boolean {
  if (workspaceRoot === null) return true;
  const candidate = extractCandidatePath(command);
  // No path-like token found: the implicit target is the workspace root
  // itself (e.g. a bare `rm -rf` run with cwd == workspaceRoot), which is
  // trivially inside the root.
  if (candidate === null) return false;
  return !isPathWithinRoot(candidate, workspaceRoot);
}

function scanForScopeBroadening(command: string, workspaceRoot: string | null): boolean {
  if (!WRITE_DELETE_VERB.test(command)) return false;
  const tokens = command.trim().split(/\s+/);
  const absolutePathTokens = tokens.filter((t) => ABSOLUTE_PATH_TOKEN_START.test(t));
  if (absolutePathTokens.length === 0) return false;
  for (const token of absolutePathTokens) {
    if (workspaceRoot === null) return true;
    if (!isPathWithinRoot(token, workspaceRoot)) return true;
  }
  return false;
}

/**
 * Classify a command into a safety tier.
 *
 * - Tier 0: no match, unrestricted.
 * - Tier 1: hard-blocked, never overridable via `allowOutsideWorkspace`.
 * - Tier 2: requires local human confirmation.
 *
 * Best-effort, regex-based — see the module-level comment for limitations.
 */
export function scanCommand(
  command: string,
  workspaceRoot: string | null,
  allowOutsideWorkspace: boolean
): SafetyVerdict {
  for (const { regex, label } of TIER1_PATTERNS) {
    if (regex.test(command)) {
      return { tier: 1, label };
    }
  }

  for (const regex of RECURSIVE_DELETE_PATTERNS) {
    if (regex.test(command)) {
      const outside = resolvesOutsideWorkspace(command, workspaceRoot);
      if (outside && !allowOutsideWorkspace) {
        return { tier: 2, label: 'recursive-delete' };
      }
      // Inside the workspace root (or opted out): tier 0 for this pattern,
      // but keep checking the remaining always-on tier-2 patterns below.
      break;
    }
  }

  if (FORCE_PUSH_PATTERN.test(command)) {
    return { tier: 2, label: 'force-push' };
  }

  for (const regex of REGISTRY_DELETE_PATTERNS) {
    if (regex.test(command)) {
      return { tier: 2, label: 'registry-delete' };
    }
  }

  for (const regex of POWER_CONTROL_PATTERNS) {
    if (regex.test(command)) {
      return { tier: 2, label: 'power-control' };
    }
  }

  if (!allowOutsideWorkspace && scanForScopeBroadening(command, workspaceRoot)) {
    return { tier: 2, label: 'scope-broadening' };
  }

  return { tier: 0 };
}
