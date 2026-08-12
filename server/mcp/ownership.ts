import db from '../db.js';

export type OwnedIdField = 'tool_ids' | 'mcp_server_ids';

export type OwnedIdsValidation =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

const RESOURCE_BY_FIELD: Record<OwnedIdField, { table: 'tools' | 'mcp_servers'; label: string }> = {
  tool_ids: { table: 'tools', label: 'tool_ids' },
  mcp_server_ids: { table: 'mcp_servers', label: 'mcp_server_ids' },
};

/**
 * Validates an API id array at the tenant boundary and returns a stable,
 * de-duplicated copy suitable for persistence. The generic ownership error is
 * intentional: callers must not disclose whether a foreign id exists.
 */
export function validateOwnedIds(
  value: unknown,
  field: OwnedIdField,
  userId: string,
): OwnedIdsValidation {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0 || id.trim() !== id)) {
    return { ok: false, error: `${field} must be an array of non-empty strings` };
  }

  const ids = [...new Set(value as string[])];
  const { table, label } = RESOURCE_BY_FIELD[field];
  const lookup = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND user_id = ?`);
  if (ids.some((id) => !lookup.get(id, userId))) {
    return {
      ok: false,
      error: `One or more ${label} do not exist or are not owned by this user`,
    };
  }

  return { ok: true, ids };
}

/** Returns only ids currently owned by the user (for filtering legacy links). */
export function filterOwnedIds(ids: readonly string[], field: OwnedIdField, userId: string): string[] {
  if (ids.length === 0) return [];
  const { table } = RESOURCE_BY_FIELD[field];
  const lookup = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND user_id = ?`);
  return [...new Set(ids)].filter((id) => Boolean(lookup.get(id, userId)));
}
