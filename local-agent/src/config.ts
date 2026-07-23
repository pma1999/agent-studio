/**
 * Local config file: the paired token, backend URL, and the workspace-root /
 * allowOutsideWorkspace opt-out. Lives on the paired machine only — this is
 * the "local, human-controlled opt-out" from `plan.md` "F": it can only be
 * widened by editing this file on this machine, never remotely.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LocalAgentConfig {
  backendUrl: string;
  token: string;
  agentId: string;
  workspaceRoot: string;
  /** Local, human-set opt-out for the workspace-root scoping. Defaults to false. */
  allowOutsideWorkspace: boolean;
}

export function getConfigDir(): string {
  const base = process.env.APPDATA ?? path.join(os.homedir(), '.config');
  return path.join(base, 'agent-studio-local-agent');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

function isValidConfig(value: unknown): value is LocalAgentConfig {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.backendUrl === 'string' &&
    typeof record.token === 'string' &&
    typeof record.agentId === 'string' &&
    typeof record.workspaceRoot === 'string'
  );
}

/** Returns null when there is no config yet, or it cannot be read/parsed — both mean "run the pairing flow". */
export function loadConfig(): LocalAgentConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!isValidConfig(parsed)) {
      console.warn(`[local-agent] Config at ${configPath} is missing required fields; ignoring it.`);
      return null;
    }
    return {
      backendUrl: parsed.backendUrl,
      token: parsed.token,
      agentId: parsed.agentId,
      workspaceRoot: parsed.workspaceRoot,
      allowOutsideWorkspace: (parsed as { allowOutsideWorkspace?: unknown }).allowOutsideWorkspace === true,
    };
  } catch (error) {
    console.warn(`[local-agent] Failed to read config at ${configPath}:`, error);
    return null;
  }
}

export function saveConfig(config: LocalAgentConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}
