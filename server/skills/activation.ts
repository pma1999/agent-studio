import path from 'node:path';
import { nanoid } from 'nanoid';
import db from '../db.js';
import {
  getAgentShellInfo,
  isAgentConnected,
  sendCommandRequest,
  sendFileOpRequest,
} from '../agentRelay/registry.js';
import type { ResolvedTool } from '../tools/resolve.js';
import type { RunToolResult } from '../tools/run.js';
import { FILE_OP_TIMEOUT_MS } from '../tools/execFileOps.js';
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  truncateCommandOutput,
} from '../tools/execCommand.js';
import { logToolExecution } from '../tools/execAudit.js';
import type { ResolvedSkill } from './resolve.js';
import {
  isLikelyTextFile,
  listSkillResourceFiles,
  MAX_SKILL_RESOURCE_READ_CHARS,
  readSkillResourceFile,
} from './storage.js';
import { scanCommand } from '../../shared/commandSafety.js';

export type ResolvedToolSkillConfig =
  | { kind: 'skill_activate' }
  | { kind: 'skill_read_resource' }
  | { kind: 'skill_run_script' };

const SUPPORTED_SCRIPT_EXTENSIONS = ['.py', '.sh', '.js', '.ts', '.rb', '.ps1'] as const;

export type ScriptShellQuoting = 'posix' | 'powershell';

/**
 * Resolve only the explicitly supported script interpreters. Returning null
 * for an unknown extension keeps script execution allowlisted rather than
 * falling back to an executable interpretation guessed from the filename.
 */
export function resolveScriptInterpreter(
  extension: string,
  platform?: string,
  shellKind?: string,
): string | null {
  const normalizedExtension = extension.trim().toLowerCase();
  const normalizedPlatform = platform?.trim().toLowerCase();
  const normalizedShellKind = shellKind?.trim().toLowerCase();

  if (normalizedExtension === '.py') {
    return normalizedPlatform === 'win32' || normalizedPlatform === 'windows' ? 'python' : 'python3';
  }
  if (normalizedExtension === '.sh') return 'bash';
  if (normalizedExtension === '.js') return 'node';
  if (normalizedExtension === '.ts') return 'npx tsx';
  if (normalizedExtension === '.rb') return 'ruby';
  if (normalizedExtension === '.ps1') {
    if (normalizedShellKind === 'pwsh') return 'pwsh -File';
    if (normalizedShellKind === 'powershell') return 'powershell -File';
  }
  return null;
}

/**
 * Return a quoting strategy only for shells whose command-text quoting is
 * covered here. cmd.exe is intentionally unsupported: its percent expansion,
 * quote handling, and shell:true invocation path cannot be made safe for
 * arbitrary model-provided arguments with the quoting contract used by this
 * tool. The caller must reject before pushing files or constructing a command.
 */
export function resolveScriptShellQuoting(shellKind?: string): ScriptShellQuoting | null {
  const normalizedShellKind = shellKind?.trim().toLowerCase();
  if (normalizedShellKind === 'bash' || normalizedShellKind === 'sh') return 'posix';
  if (normalizedShellKind === 'pwsh' || normalizedShellKind === 'powershell') return 'powershell';
  return null;
}

export function isValidSkillScriptPath(scriptPath: string): boolean {
  return scriptPath.startsWith('scripts/');
}

/**
 * Quote one argument for the connected agent's shell, keeping the value one
 * shell token. PowerShell uses single-quoted literals, where apostrophes are
 * doubled. POSIX shells retain the existing double-quoted convention. cmd.exe
 * and unknown shells are rejected instead of receiving a silently-unsafe
 * POSIX quote.
 */
export function shellQuoteArg(value: string, shellKind = 'bash'): string {
  const strategy = resolveScriptShellQuoting(shellKind);
  if (!strategy) {
    const displayShellKind = shellKind.trim() || 'unknown';
    throw new Error(`run_skill_script is not supported when the connected local agent's shell is ${displayShellKind}`);
  }
  if (strategy === 'powershell') return `'${value.replace(/'/g, "''")}'`;
  return `"${value.replace(/["\\$`]/g, (character) => `\\${character}`)}"`;
}

export function buildSkillScriptCommand(
  interpreter: string,
  scriptPath: string,
  args: string[] = [],
  shellKind = 'bash',
): string {
  const argsPart = args.length > 0 ? ` ${args.map((arg) => shellQuoteArg(arg, shellKind)).join(' ')}` : '';
  return `${interpreter} ${shellQuoteArg(path.basename(scriptPath), shellKind)}${argsPart}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function compareSkills(a: ResolvedSkill, b: ResolvedSkill): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Appends the stable, metadata-only skill catalog to the system prompt.
 * Skill bodies are intentionally loaded only after activation so this prefix
 * remains small and cacheable across turns.
 */
export function appendSkillCatalogIfNeeded(systemPrompt: string, resolvedSkills: ResolvedSkill[]): string {
  const eligibleSkills = resolvedSkills
    .filter((skill) => !skill.disableModelInvocation)
    .sort(compareSkills);
  if (eligibleSkills.length === 0) return systemPrompt;

  const catalog = eligibleSkills.map((skill) => [
    '  <skill>',
    `    <name>${escapeXml(skill.name)}</name>`,
    `    <description>${escapeXml(skill.description)}</description>`,
    '  </skill>',
  ].join('\n')).join('\n');

  return `${systemPrompt}\n\nThe following skills provide specialized instructions for specific tasks. When a task matches a skill's description, call the activate_skill tool with the skill's name to load its full instructions.\n\n<available_skills>\n${catalog}\n</available_skills>`;
}

export function buildActivateSkillTool(resolvedSkills: ResolvedSkill[]): ResolvedTool | null {
  const eligibleSkills = resolvedSkills.filter((skill) => !skill.disableModelInvocation);
  if (eligibleSkills.length === 0) return null;

  return {
    id: 'skill_activate',
    name: 'activate_skill',
    type: 'skill',
    config: { kind: 'skill_activate' } as ResolvedToolSkillConfig,
    skillCatalog: resolvedSkills,
    openAIDef: {
      type: 'function',
      function: {
        name: 'activate_skill',
        description: 'Load the full instructions for an available skill when its description matches the task.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              enum: eligibleSkills.map((skill) => skill.name),
              description: 'Exact name of the skill to activate.',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
  };
}

export function buildReadSkillResourceTool(resolvedSkills: ResolvedSkill[]): ResolvedTool | null {
  if (resolvedSkills.length === 0) return null;

  return {
    id: 'skill_read_resource',
    name: 'read_skill_resource',
    type: 'skill',
    config: { kind: 'skill_read_resource' } as ResolvedToolSkillConfig,
    skillCatalog: resolvedSkills,
    openAIDef: {
      type: 'function',
      function: {
        name: 'read_skill_resource',
        description: 'Read a bundled resource from a skill that is available in this conversation.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              enum: resolvedSkills.map((skill) => skill.name),
              description: 'Exact name of the skill whose resource should be read.',
            },
            path: {
              type: 'string',
              description: 'Relative path of the bundled resource to read.',
            },
          },
          required: ['name', 'path'],
          additionalProperties: false,
        },
      },
    },
  };
}

export function buildRunSkillScriptTool(resolvedSkills: ResolvedSkill[], userId: string): ResolvedTool | null {
  if (resolvedSkills.length === 0 || !isAgentConnected(userId)) return null;

  return {
    id: 'skill_run_script',
    name: 'run_skill_script',
    type: 'skill',
    config: { kind: 'skill_run_script' } as ResolvedToolSkillConfig,
    skillCatalog: resolvedSkills,
    openAIDef: {
      type: 'function',
      function: {
        name: 'run_skill_script',
        description: "Execute a bundled script from an activated skill's scripts/ directory on the user's connected local machine (real files, installed tools, persists across calls) and return its stdout, stderr, and exit_code. Only files under a skill's scripts/ directory can be run — not references/ or assets/. A non-zero exit_code or non-empty stderr does not necessarily mean the script failed; inspect the output. Requires a connected local agent.",
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              enum: resolvedSkills.map((skill) => skill.name),
              description: 'Exact name of the skill that owns this script.',
            },
            script_path: {
              type: 'string',
              description: "Relative path of the script, must start with 'scripts/', exactly as listed in the skill's <skill_resources> block.",
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional command-line arguments, one per array element (not a single shell string).',
            },
            timeout_seconds: {
              type: 'number',
              description: 'Max seconds to wait (default 120, hard ceiling 1800).',
            },
          },
          required: ['name', 'script_path'],
          additionalProperties: false,
        },
      },
    },
  };
}

interface SkillActivationRow {
  body: string;
  storage_dir: string;
}

export function tryActivateSkill(params: {
  name: string;
  userId: string;
  currentMessages: Array<{ role: string; content?: unknown }>;
}): { content: string; alreadyActive: boolean } | null {
  if (hasSkillAlreadyActivated(params.currentMessages, params.name)) {
    return {
      content: `Skill "${escapeXml(params.name)}" is already active in this conversation.`,
      alreadyActive: true,
    };
  }

  const row = db.prepare('SELECT body, storage_dir FROM skills WHERE user_id = ? AND name = ?').get(params.userId, params.name) as SkillActivationRow | undefined;
  if (!row) return null;

  const resources = listSkillResourceFiles(row.storage_dir);
  return {
    content: formatSkillActivationContent(params.name, row.body, resources),
    alreadyActive: false,
  };
}

export function formatSkillActivationContent(name: string, body: string, resources: { path: string; size_bytes: number }[]): string {
  // Keep normal Markdown intact, but neutralize a body-authored closing tag so
  // it cannot be mistaken for the wrapper's own delimiter.
  const safeBody = body.trim().replace(/<\/skill_content\b[^>]*>/gi, (tag) => escapeXml(tag));
  const resourceBlock = resources.length
    ? `\n\n<skill_resources>\n${resources.map((resource) => `  <file>${escapeXml(resource.path)}</file>`).join('\n')}\n</skill_resources>`
    : '';
  return `<skill_content name="${escapeXml(name)}">\n${safeBody}${resourceBlock}\n</skill_content>`;
}

export function hasSkillAlreadyActivated(messages: Array<{ role: string; content?: unknown }>, skillName: string): boolean {
  const marker = `<skill_content name="${escapeXml(skillName)}"`;
  for (const message of messages) {
    const content = message.content;
    if (typeof content === 'string' && content.includes(marker)) return true;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === 'string' && part.includes(marker)) return true;
      if (!part || typeof part !== 'object' || !('text' in part)) continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string' && text.includes(marker)) return true;
    }
  }
  return false;
}

export function injectSkillActivationIntoCurrentTurn(
  messages: Array<{ role: string; content?: string | unknown[] | null }>,
  activationContent: string,
): void {
  const lastIdx = messages.length - 1;
  if (lastIdx < 0 || messages[lastIdx].role !== 'user') return;
  const current = messages[lastIdx];
  if (Array.isArray(current.content)) {
    current.content = [...current.content, { type: 'text', text: activationContent }];
  } else {
    const base = typeof current.content === 'string' ? current.content : '';
    current.content = base ? `${base}\n\n${activationContent}` : activationContent;
  }
}

function skillToolError(message: string): RunToolResult {
  return { output: JSON.stringify({ error: message }), isError: true, source: 'skill' };
}

type SkillScriptConfirmation = 'approved' | 'declined' | 'timeout';

type SkillScriptWriteResponse = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
};

interface SkillToolContext {
  userId: string;
  currentMessages: Array<{ role: string; content?: unknown }>;
  conversationId?: string;
}

function skillScriptErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'error' in error) {
    const nested = (error as { error?: unknown }).error;
    if (typeof nested === 'string' && nested) return nested;
  }
  const message = String(error);
  return message && message !== '[object Object]' ? message : fallback;
}

async function runSkillScriptTool(
  tool: ResolvedTool,
  args: Record<string, unknown>,
  context: SkillToolContext,
): Promise<RunToolResult> {
  const startedAt = Date.now();
  let auditLogged = false;
  let auditCommand: string | null = null;
  let auditCwd: string | null = null;
  let auditExitCode: number | null = null;
  let auditBlockedPattern: string | null = null;
  let auditConfirmationRequired = false;
  let auditConfirmationResult: SkillScriptConfirmation | null = null;

  const finish = (output: Record<string, unknown>, isError: boolean): RunToolResult => {
    if (!auditLogged) {
      auditLogged = true;
      logToolExecution({
        userId: context.userId,
        conversationId: context.conversationId,
        toolName: 'run_skill_script',
        backend: 'local',
        command: auditCommand,
        cwd: auditCwd,
        exitCode: auditExitCode,
        durationMs: Date.now() - startedAt,
        blockedPattern: auditBlockedPattern,
        confirmationRequired: auditConfirmationRequired,
        confirmationResult: auditConfirmationResult,
        isError,
      });
    }
    return { output: JSON.stringify(output), isError, source: 'skill' };
  };

  try {
    const rawName = args?.name;
    if (typeof rawName !== 'string' || !rawName.trim()) {
      return finish({ error: 'A skill name is required' }, true);
    }

    const rawScriptPath = args?.script_path;
    if (typeof rawScriptPath !== 'string' || !rawScriptPath.trim()) {
      return finish({ error: 'A script path is required' }, true);
    }
    if (!isValidSkillScriptPath(rawScriptPath)) {
      return finish({ error: "Script path must start with 'scripts/'" }, true);
    }

    const catalog = tool.skillCatalog || [];
    const entry = catalog.find((skill) => skill.name === rawName);
    if (!entry) return finish({ error: `Unknown skill: ${rawName}` }, true);

    if (!isAgentConnected(context.userId)) {
      return finish({ error: 'local agent is not connected' }, true);
    }

    const identity = getAgentShellInfo(context.userId);
    const shellKind = identity?.shell?.kind?.trim().toLowerCase() || 'unknown';
    if (!resolveScriptShellQuoting(shellKind)) {
      return finish({
        error: `run_skill_script is not supported when the connected local agent's shell is ${shellKind}`,
      }, true);
    }

    const rawArgs = args?.args;
    if (rawArgs !== undefined && (!Array.isArray(rawArgs) || !rawArgs.every((arg) => typeof arg === 'string'))) {
      return finish({ error: 'args must be an array of strings' }, true);
    }
    const scriptArgs = rawArgs === undefined ? [] : rawArgs as string[];

    const rawTimeout = args?.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      return finish({ error: 'timeout_seconds must be a positive finite number' }, true);
    }
    const timeoutSeconds = Math.min(rawTimeout, MAX_TIMEOUT_SECONDS);

    const row = db.prepare('SELECT storage_dir FROM skills WHERE user_id = ? AND name = ?').get(context.userId, rawName) as { storage_dir: string } | undefined;
    if (!row) return finish({ error: `Skill could not be loaded: ${rawName}` }, true);

    const scriptPath = rawScriptPath;
    const extension = path.extname(scriptPath).toLowerCase();
    const interpreter = resolveScriptInterpreter(extension, identity?.platform, identity?.shell?.kind);
    if (!interpreter) {
      return finish({
        error: `Unsupported script type '${extension || '(none)'}'. Supported types: ${SUPPORTED_SCRIPT_EXTENSIONS.join(', ')}`,
      }, true);
    }

    const scriptResources = listSkillResourceFiles(row.storage_dir)
      .filter((resource) => resource.path.startsWith('scripts/'));
    const requestedResource = scriptResources.find((resource) => resource.path === scriptPath);
    if (!requestedResource) return finish({ error: `Script not found: ${scriptPath}` }, true);

    const filesToPush: Array<{ path: string; content: string }> = [];
    const requestedResult = readSkillResourceFile(row.storage_dir, scriptPath);
    if ('error' in requestedResult) return finish({ error: requestedResult.error }, true);
    if (!isLikelyTextFile(requestedResult.data, scriptPath)) {
      return finish({ error: `Script cannot be executed because it is binary: ${scriptPath}` }, true);
    }
    filesToPush.push({ path: scriptPath, content: requestedResult.data.toString('utf8') });

    for (const resource of scriptResources) {
      if (resource.path === scriptPath) continue;
      try {
        const siblingResult = readSkillResourceFile(row.storage_dir, resource.path);
        if ('error' in siblingResult) {
          console.warn(`[run_skill_script] skipping unreadable script sibling '${resource.path}': ${siblingResult.error}`);
          continue;
        }
        if (!isLikelyTextFile(siblingResult.data, resource.path)) {
          console.warn(`[run_skill_script] skipping binary script sibling '${resource.path}'`);
          continue;
        }
        filesToPush.push({ path: resource.path, content: siblingResult.data.toString('utf8') });
      } catch (error) {
        const message = skillScriptErrorMessage(error, 'failed to read sibling');
        console.warn(`[run_skill_script] skipping unreadable script sibling '${resource.path}': ${message}`);
      }
    }

    for (const file of filesToPush) {
      const isRequestedScript = file.path === scriptPath;
      const requestPath = `.agent-studio-skills/${entry.name}/${file.path}`;
      try {
        const response = await sendFileOpRequest<SkillScriptWriteResponse>(context.userId, {
          type: 'write_file_request',
          requestId: `skill_script_push_${nanoid()}`,
          path: requestPath,
          content: file.content,
          hasBeenRead: true,
        }, FILE_OP_TIMEOUT_MS);
        if (response.ok === true) continue;

        const responseError = response.error || 'local agent rejected the file';
        if (isRequestedScript) {
          return finish({ error: `Failed to push script: ${responseError}` }, true);
        }
        console.warn(`[run_skill_script] skipping script sibling '${file.path}' after push failure: ${responseError}`);
      } catch (error) {
        const message = skillScriptErrorMessage(error, 'local agent file push failed');
        if (isRequestedScript) return finish({ error: `Failed to push script: ${message}` }, true);
        console.warn(`[run_skill_script] skipping script sibling '${file.path}' after push failure: ${message}`);
      }
    }

    const cwd = `.agent-studio-skills/${entry.name}/${path.posix.dirname(scriptPath)}`;
    const command = buildSkillScriptCommand(interpreter, scriptPath, scriptArgs, shellKind);
    auditCommand = command;
    auditCwd = cwd;

    const verdict = scanCommand(command, null, true);
    if (verdict.tier === 1) {
      auditBlockedPattern = verdict.label || 'unknown';
      return finish({
        error: 'Command blocked by the command-safety policy.',
        blocked: { tier: 1, pattern: verdict.label || 'unknown' },
      }, true);
    }

    try {
      const result = await sendCommandRequest(
        context.userId,
        `skill_script_${nanoid()}`,
        command,
        cwd,
        timeoutSeconds * 1000,
        () => {},
      );
      auditExitCode = result.exitCode ?? null;
      auditBlockedPattern = result.blockedPattern ?? null;
      auditConfirmationRequired = result.confirmation !== undefined;
      auditConfirmationResult = result.confirmation ?? null;

      if (result.confirmation === 'declined' || result.confirmation === 'timeout') {
        return finish({
          error: result.confirmation === 'declined'
            ? 'Command confirmation was declined; the command was not executed.'
            : 'Command confirmation timed out; the command was not executed.',
          confirmation: result.confirmation,
        }, true);
      }

      const stdout = truncateCommandOutput(String(result.stdout ?? ''));
      const stderr = truncateCommandOutput(String(result.stderr ?? ''));
      return finish({
        stdout: stdout.text,
        stderr: stderr.text,
        exit_code: result.exitCode ?? null,
        backend: 'local',
        resolved_cwd: cwd,
        timeout_seconds_applied: timeoutSeconds,
        truncated: stdout.truncated || stderr.truncated,
      }, false);
    } catch (error) {
      return finish({ error: skillScriptErrorMessage(error, 'local agent command failed') }, true);
    }
  } catch (error) {
    return finish({ error: skillScriptErrorMessage(error, 'run_skill_script failed') }, true);
  }
}

export async function runSkillTool(
  tool: ResolvedTool,
  args: Record<string, unknown>,
  context: SkillToolContext,
): Promise<RunToolResult> {
  const config = tool.config as Partial<ResolvedToolSkillConfig> | null | undefined;
  const catalog = tool.skillCatalog || [];
  const name = typeof args?.name === 'string' ? args.name : '';

  if (config?.kind === 'skill_activate') {
    const entry = catalog.find((skill) => skill.name === name);
    if (!entry || entry.disableModelInvocation) {
      return skillToolError(`Unknown or disabled skill: ${name}`);
    }

    const activation = tryActivateSkill({
      name,
      userId: context.userId,
      currentMessages: context.currentMessages,
    });
    if (!activation) return skillToolError(`Skill could not be loaded: ${name}`);
    return { output: activation.content, isError: false, source: 'skill' };
  }

  if (config?.kind === 'skill_read_resource') {
    const entry = catalog.find((skill) => skill.name === name);
    if (!entry) return skillToolError(`Unknown skill: ${name}`);

    const resourcePath = typeof args.path === 'string' ? args.path : '';
    if (!resourcePath.trim()) return skillToolError('A resource path is required');

    const row = db.prepare('SELECT storage_dir FROM skills WHERE user_id = ? AND name = ?').get(context.userId, name) as { storage_dir: string } | undefined;
    if (!row) return skillToolError(`Skill could not be loaded: ${name}`);

    const result = readSkillResourceFile(row.storage_dir, resourcePath);
    if ('error' in result) return skillToolError(result.error);

    if (!isLikelyTextFile(result.data, resourcePath)) {
      return {
        output: JSON.stringify({
          path: resourcePath,
          binary: true,
          size_bytes: result.data.length,
          note: 'Binary resource was not decoded as text.',
        }),
        isError: false,
        source: 'skill',
      };
    }

    const decoded = result.data.toString('utf8');
    const truncated = decoded.length > MAX_SKILL_RESOURCE_READ_CHARS;
    return {
      output: JSON.stringify({
        path: resourcePath,
        content: truncated ? decoded.slice(0, MAX_SKILL_RESOURCE_READ_CHARS) : decoded,
        truncated,
      }),
      isError: false,
      source: 'skill',
    };
  }

  if (config?.kind === 'skill_run_script') {
    return runSkillScriptTool(tool, args, context);
  }

  return skillToolError('Unsupported skill tool configuration');
}
