import assert from 'node:assert/strict';
import { selectToolResolutionSource } from '../server/tools/index.js';

// 1. Active conversation override wins regardless of isGeneralChat/generalSettings
assert.deepEqual(
  selectToolResolutionSource({
    conversationOverride: { tools_overridden: true, tool_ids: ['t1', 't2'], mcp_server_ids: ['m1'] },
    isGeneralChat: true,
    generalSettings: { tool_ids: ['gen1'], mcp_server_ids: ['genm1'] },
  }),
  { kind: 'conversation-override', tool_ids: ['t1', 't2'], mcp_server_ids: ['m1'] }
);

// 2. No override + isGeneralChat true + non-null generalSettings -> general-settings
assert.deepEqual(
  selectToolResolutionSource({
    conversationOverride: { tools_overridden: false, tool_ids: [], mcp_server_ids: [] },
    isGeneralChat: true,
    generalSettings: { tool_ids: ['gen1'], mcp_server_ids: ['genm1'] },
  }),
  { kind: 'general-settings', tool_ids: ['gen1'], mcp_server_ids: ['genm1'] }
);

// 3. No override + isGeneralChat false -> agent-default regardless of generalSettings
assert.deepEqual(
  selectToolResolutionSource({
    conversationOverride: { tools_overridden: false, tool_ids: [], mcp_server_ids: [] },
    isGeneralChat: false,
    generalSettings: { tool_ids: ['gen1'], mcp_server_ids: ['genm1'] },
  }),
  { kind: 'agent-default' }
);
assert.deepEqual(
  selectToolResolutionSource({
    conversationOverride: { tools_overridden: false, tool_ids: [], mcp_server_ids: [] },
    isGeneralChat: false,
    generalSettings: null,
  }),
  { kind: 'agent-default' }
);

// 4. Active override with both arrays empty still returns conversation-override, not "no override"
assert.deepEqual(
  selectToolResolutionSource({
    conversationOverride: { tools_overridden: true, tool_ids: [], mcp_server_ids: [] },
    isGeneralChat: false,
    generalSettings: null,
  }),
  { kind: 'conversation-override', tool_ids: [], mcp_server_ids: [] }
);

console.log('conversation tool override precedence: OK');
