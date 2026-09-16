/**
 * Compaction prompt builder (pure, no db/network imports).
 *
 * The wire prompt is assembled from TWO upstream originals, kept VERBATIM so
 * they can be re-diffed against their sources at any time:
 *
 *  - `CODEX_CORE` — byte-identical to `openai/codex@main`
 *    `codex-rs/prompts/templates/compact/prompt.md` (425 bytes, trailing
 *    newline stripped). Its markdown bullet list KEEPS its line breaks: an
 *    earlier version flattened it onto one line and added a full stop.
 *  - `TEMPLATE_HEAD` / `TEMPLATE_RULES` — byte-identical halves of
 *    `sst/opencode@dev` `packages/core/src/session/compaction.ts`
 *    `SUMMARY_TEMPLATE`, `<template>` tags and `Rules:` block included. The
 *    only agent-studio addition is the `## Session Facts` section inserted
 *    inside the template, plus one matching rule.
 *  - `SUMMARY_UPDATE_INSTRUCTIONS` — byte-identical to the same OpenCode file;
 *    it replaces the old hand-written `MERGE_RULES` paragraph.
 *
 * `scripts/test-compact-prompt.ts` pins these blocks against the upstream text.
 */

export const COMPACTION_PROMPT_VERSION = 'v2';

/** G2 compaction-row prefix (Codex `SUMMARY_PREFIX` pattern, adapted to what we
 *  actually retain: the summary plus the recent user messages replayed after
 *  it). It is stored ON the row, so readers strip it — never change it lightly. */
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

/** Verbatim: openai/codex `codex-rs/prompts/templates/compact/prompt.md`. */
const CODEX_CORE = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

/** Verbatim: sst/opencode `core/src/session/compaction.ts`
 *  `SUMMARY_UPDATE_INSTRUCTIONS`. */
const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`;

/** Verbatim: the same file's `SUMMARY_TEMPLATE`, split in two so the
 *  agent-studio `## Session Facts` section lands inside `<template>`. */
const TEMPLATE_HEAD = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
`;
const TEMPLATE_RULES = `

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

function summaryTemplate(vars: CompactionPromptVars): string {
  const sessionFacts = [
    '',
    '## Session Facts',
    `- conversation_id: ${vars.conversationId} | model: ${vars.modelId} | provider: ${vars.provider} | compacted_at: ${vars.compactedAtIso} | messages_compacted: ${vars.messagesCompacted} | tokens_before: ${vars.tokensBefore}`,
  ].join('\n');
  return (
    TEMPLATE_HEAD +
    sessionFacts +
    '\n</template>' +
    TEMPLATE_RULES +
    '\n- Reproduce the "## Session Facts" line exactly as given.'
  );
}

/**
 * Builds the summarizer prompt: Codex core, then the OpenCode conversation
 * block, then (only when a prior checkpoint exists) the prior-summary block +
 * the OpenCode merge instructions, then the optional operator-focus line, then
 * the template. Blocks are joined with a blank line, as OpenCode does.
 */
export function buildCompactionPrompt(vars: CompactionPromptVars): string {
  const blocks: string[] = [
    CODEX_CORE,
    `Here is the conversation so far:\n\n<conversation>\n${vars.serializedHead}\n</conversation>`,
  ];

  if (vars.priorSummary != null) {
    blocks.push(
      `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${vars.priorSummary}\n</prior-summary>`,
    );
    blocks.push(SUMMARY_UPDATE_INSTRUCTIONS);
  }

  if (vars.focus != null && vars.focus !== '') {
    blocks.push(`Operator focus (prioritize this; compress everything else harder): ${vars.focus}`);
  }

  blocks.push(summaryTemplate(vars));
  return blocks.join('\n\n');
}
