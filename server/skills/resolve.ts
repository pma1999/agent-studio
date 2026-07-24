import db from '../db.js';

export interface ResolvedSkill {
  id: string;
  name: string;
  description: string;
  disableModelInvocation: boolean;
}

interface SkillResolutionRow {
  id: string;
  name: string;
  description: string;
  disable_model_invocation: number;
}

function toResolvedSkill(row: SkillResolutionRow): ResolvedSkill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    disableModelInvocation: !!row.disable_model_invocation,
  };
}

export function resolveSkillsForAgent(agentId: string, userId: string): ResolvedSkill[] {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.description, s.disable_model_invocation
    FROM skills s
    INNER JOIN agent_skills asg ON asg.skill_id = s.id
    WHERE asg.agent_id = ? AND s.user_id = ?
  `).all(agentId, userId) as SkillResolutionRow[];
  return rows.map(toResolvedSkill);
}

export interface ResolveSkillsFromIdsOptions {
  byIdOnly?: boolean;
}

export function resolveSkillsFromIds(
  skillIds: string[],
  userId: string,
  options?: ResolveSkillsFromIdsOptions,
): ResolvedSkill[] {
  if (skillIds.length === 0) return [];

  const placeholders = skillIds.map(() => '?').join(',');
  const rows = options?.byIdOnly === true
    ? db.prepare(`
        SELECT id, name, description, disable_model_invocation
        FROM skills
        WHERE id IN (${placeholders})
      `).all(...skillIds) as SkillResolutionRow[]
    : db.prepare(`
        SELECT id, name, description, disable_model_invocation
        FROM skills
        WHERE id IN (${placeholders}) AND user_id = ?
      `).all(...skillIds, userId) as SkillResolutionRow[];

  return rows.map(toResolvedSkill);
}

export interface ConversationSkillOverride {
  skills_overridden: boolean;
  skill_ids: string[];
}

export function getConversationSkillOverride(conversationId: string): ConversationSkillOverride {
  const row = db.prepare('SELECT skills_overridden FROM conversations WHERE id = ?').get(conversationId) as
    | { skills_overridden: number }
    | undefined;
  const skillsOverridden = !!row?.skills_overridden;
  const skillLinks = db.prepare(
    'SELECT skill_id FROM conversation_skills WHERE conversation_id = ?',
  ).all(conversationId) as { skill_id: string }[];

  return {
    skills_overridden: skillsOverridden,
    skill_ids: skillLinks.map((link) => link.skill_id),
  };
}

export type SkillResolutionSource =
  | { kind: 'conversation-override'; skill_ids: string[] }
  | { kind: 'general-settings'; skill_ids: string[] }
  | { kind: 'agent-default' };

export function selectSkillResolutionSource(params: {
  conversationOverride: ConversationSkillOverride;
  isGeneralChat: boolean;
  generalSettings: { skill_ids: string[] } | null;
}): SkillResolutionSource {
  const { conversationOverride, isGeneralChat, generalSettings } = params;
  if (conversationOverride.skills_overridden === true) {
    return {
      kind: 'conversation-override',
      skill_ids: conversationOverride.skill_ids,
    };
  }
  if (isGeneralChat && generalSettings !== null) {
    return {
      kind: 'general-settings',
      skill_ids: generalSettings.skill_ids,
    };
  }
  return { kind: 'agent-default' };
}
