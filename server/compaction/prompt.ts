/**
 * Compaction prompt builder (pure, no db/network imports).
 *
 * Source of truth for wording: plans/compact-command/integration-compact.md §6.1
 * with G3 (verbatim Codex core + 9-heading order) and G2 (SUMMARY_PREFIX literal)
 * authoritative on conflict per global-constraints.md.
 */

export const COMPACTION_PROMPT_VERSION = 'v1';

/** G2 compaction-row prefix (Codex SUMMARY_PREFIX pattern, adapted). Exact literal. */
export const SUMMARY_PREFIX =
  'Another language model summarized this conversation so it could continue in a smaller context. Use the summary as prior state; the verbatim tail after it is newest. Do not duplicate completed work. Summary:\n';

export const SUMMARY_REASK_INSTRUCTION =
  'Your previous response did not follow the required template. Output exactly the Markdown structure with all nine headings in order, keeping every section (write "(none)" when empty).';

export interface CompactionPromptVars {
  serializedHead: string;
  priorSummary: string | null;
  focus: string | null;
  conversationId: string;
  modelId: string;
  provider: string;
  compactedAtIso: string;
  messagesCompacted: number;
  tokensBefore: number;
}

/** G3 Codex core — verbatim, do not reword. */
const CODEX_CORE =
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task. Include: - Current progress and key decisions made - Important context, constraints, or user preferences - What remains to be done (clear next steps) - Any critical data, examples, or references needed to continue. Be concise, structured, and focused on helping the next LLM seamlessly continue the work.';

const PRIOR_LEAD =
  'Prior summary (combines everything before <conversation>; it is discarded after this — anything not carried forward is lost):';

const MERGE_RULES =
  'Merge rules: carry forward objectives, constraints, user directives, decisions, and parallel workstreams even when <conversation> omits them; on conflict, <conversation> wins — state the corrected fact, drop the old claim; move finished Active→Completed; refresh Objective and Next Move.';

// §6.1 instruction, minus the "<template>" wrapper sentences: the wire format
// sends the template body without literal <template> tags, so referencing them
// would be incoherent. All other normative content is kept verbatim.
const OUTPUT_INSTRUCTION =
  'Output exactly the Markdown structure below, keep section order, keep every section even when empty (write "(none)"). Terse bullets, not prose. Preserve exact file paths, symbols, commands, error strings, URLs, model names, and identifiers. Do not mention summarization/compaction.';

/**
 * Builds the summarizer prompt: G3 Codex core verbatim followed by the §6.1
 * template body (9 headings in order, no <template> wrapper tags). The prior
 * block (lead + <prior-summary> + merge rules) is omitted entirely when
 * priorSummary is null; the focus line is omitted when focus is null/empty.
 * Every variable is substituted — no `{{...}}` remains in the output.
 */
export function buildCompactionPrompt(vars: CompactionPromptVars): string {
  const parts: string[] = [];

  parts.push(CODEX_CORE);
  parts.push('');
  parts.push('Conversation to summarize:');
  parts.push('<conversation>');
  parts.push(vars.serializedHead);
  parts.push('</conversation>');

  if (vars.priorSummary != null) {
    parts.push(PRIOR_LEAD);
    parts.push('<prior-summary>');
    parts.push(vars.priorSummary);
    parts.push('</prior-summary>');
    parts.push(MERGE_RULES);
  }

  if (vars.focus != null && vars.focus !== '') {
    parts.push(`Operator focus (prioritize this; compress everything else harder): ${vars.focus}`);
  }

  parts.push('');
  parts.push(OUTPUT_INSTRUCTION);
  parts.push('## Objective');
  parts.push('- [1–2 sentences: what the user is trying to accomplish]');
  parts.push('## Important Details');
  parts.push('- [constraints/preferences, decisions + why, facts/assumptions, exact context to continue, or "(none)"]');
  parts.push('## Work State');
  parts.push('### Completed');
  parts.push('- [finished + verified work/changes, or "(none)"]');
  parts.push('### Active');
  parts.push('- [current/partial work + investigation state, or "(none)"]');
  parts.push('### Blocked');
  parts.push('- [blockers, failing commands, unknowns, or "(none)"]');
  parts.push('## Next Move');
  parts.push('1. [immediate concrete action, or "(none)"]');
  parts.push('2. [next action if known, or "(none)"]');
  parts.push('## Relevant Files');
  parts.push('- [path: why it matters, or "(none)"]');
  parts.push('## Session Facts');
  parts.push(
    `- conversation_id: ${vars.conversationId} | model: ${vars.modelId} | provider: ${vars.provider} | compacted_at: ${vars.compactedAtIso} | messages_compacted: ${vars.messagesCompacted} | tokens_before: ${vars.tokensBefore}`,
  );

  return parts.join('\n');
}
