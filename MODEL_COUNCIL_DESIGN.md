# Model Council Feature - Complete Solution Design

## Executive Summary

This document provides a comprehensive design for the **Model Council** feature for Agent Studio - a multi-model execution and synthesis system similar to Perplexity's implementation. The feature runs the same query across multiple AI models simultaneously, then synthesizes their outputs into a unified, professional response.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Model & Schema Changes](#2-data-model--schema-changes)
3. [Backend API Design](#3-backend-api-design)
4. [Streaming Strategy](#4-streaming-strategy)
5. [Frontend UI/UX Design](#5-frontend-uiux-design)
6. [Synthesis Strategy & Prompt Engineering](#6-synthesis-strategy--prompt-engineering)
7. [Configuration & User Preferences](#7-configuration--user-preferences)
8. [Edge Cases & Error Handling](#8-edge-cases--error-handling)
9. [Caching Strategy](#9-caching-strategy)
10. [Migration Strategy](#10-migration-strategy)
11. [Implementation Order](#11-implementation-order)
12. [Verification Criteria](#12-verification-criteria)

---

## 1. Architecture Overview

### 1.1 Core Concept

The Model Council operates in three phases:

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  PHASE 1:       │     │  PHASE 2:        │     │  PHASE 3:       │
│  Parallel       │────▶│  Aggregation     │────▶│  Synthesis      │
│  Execution      │     │  & Storage       │     │  & Streaming    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

**Phase 1 - Parallel Execution:**
- Execute the same user query across N models (default: 3) simultaneously
- Each model receives identical context (system prompt, history, attachments)
- Models execute in parallel with individual timeouts

**Phase 2 - Aggregation:**
- Collect all model outputs (content, reasoning, tokens, cost)
- Store individual council member responses in database
- Handle partial failures gracefully

**Phase 3 - Synthesis:**
- Send all council outputs to a synthesizer model
- Synthesizer identifies agreements, disagreements, and unique insights
- Stream synthesized response to user with full transparency

### 1.2 System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT (React)                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ ModelCouncil │  │ CouncilCard  │  │ CouncilMemberResponses   │  │
│  │   Toggle     │  │   Component  │  │      Component           │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      SERVER (Express)                                │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              POST /api/chat/council                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │  │
│  │  │  Council    │  │   Parallel  │  │   Synthesis         │  │  │
│  │  │  Controller │──│   Executor  │──│   Engine            │  │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                           │                                         │
│  ┌────────────────────────┼────────────────────────────────────┐  │
│  │                   DATABASE (SQLite)                          │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │  │
│  │  │  messages    │  │council_runs  │  │council_responses │  │  │
│  │  │  (existing)  │  │  (new)       │  │    (new)         │  │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    OPENROUTER API                                    │
│         (Multiple parallel streams + synthesis model)                │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.3 Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Separate endpoint** (`/api/chat/council`) | Keeps existing chat flow unchanged; council is opt-in per message |
| **Database storage of council runs** | Enables historical analysis, caching, and cost tracking |
| **Synthesizer model is configurable** | Users can choose synthesis quality vs. speed tradeoff |
| **Individual member responses visible** | Transparency - users can inspect each model's output |
| **Streaming synthesis** | Maintains existing UX patterns; users see response build in real-time |

---

## 2. Data Model & Schema Changes

### 2.1 New Tables

#### `council_runs` - Tracks each council execution

```sql
CREATE TABLE council_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, -- Links to final synthesized message
  user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, -- The query that triggered council

  -- Configuration
  synthesizer_model TEXT NOT NULL DEFAULT 'anthropic/claude-3.5-sonnet',
  member_count INTEGER NOT NULL DEFAULT 3,
  system_prompt TEXT, -- Snapshot of system prompt used

  -- Status tracking
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'partial_failure', 'failed')) DEFAULT 'running',
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,

  -- Aggregate metrics
  total_cost REAL DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_prompt_tokens INTEGER DEFAULT 0,
  total_completion_tokens INTEGER DEFAULT 0,

  -- Error tracking (for partial failures)
  failed_members INTEGER DEFAULT 0,
  error_log TEXT, -- JSON array of errors per failed member

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_council_runs_user ON council_runs(user_id);
CREATE INDEX idx_council_runs_conversation ON council_runs(conversation_id);
CREATE INDEX idx_council_runs_message ON council_runs(message_id);
CREATE INDEX idx_council_runs_status ON council_runs(status);
```

#### `council_members` - Individual model configurations for a council

```sql
CREATE TABLE council_members (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- Display
  name TEXT NOT NULL, -- e.g., "Research Panel", "Creative Trio"
  description TEXT,
  is_default BOOLEAN DEFAULT 0, -- System-defined default councils

  -- Member models (JSON array of model IDs)
  member_models TEXT NOT NULL, -- e.g., '["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-pro-1.5"]'

  -- Synthesizer configuration
  synthesizer_model TEXT NOT NULL DEFAULT 'anthropic/claude-3.5-sonnet',
  synthesis_prompt_template TEXT, -- Custom synthesis prompt (optional)

  -- Behavior settings
  auto_expand_reasoning BOOLEAN DEFAULT 0, -- Show reasoning by default
  show_member_responses BOOLEAN DEFAULT 1, -- Show individual responses

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_council_members_user ON council_members(user_id);
CREATE INDEX idx_council_members_default ON council_members(is_default) WHERE is_default = 1;
```

#### `council_responses` - Individual responses from each council member

```sql
CREATE TABLE council_responses (
  id TEXT PRIMARY KEY,
  council_run_id TEXT NOT NULL REFERENCES council_runs(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL, -- e.g., "anthropic/claude-3.5-sonnet"

  -- Response content
  content TEXT NOT NULL,
  reasoning_content TEXT, -- Model's reasoning/thinking

  -- Usage metrics
  tokens_used INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,

  -- Timing
  response_time_ms INTEGER, -- How long this model took

  -- Status
  status TEXT NOT NULL CHECK(status IN ('success', 'error', 'timeout', 'cancelled')) DEFAULT 'success',
  error_message TEXT,

  -- Ordering for display
  display_order INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_council_responses_run ON council_responses(council_run_id);
CREATE INDEX idx_council_responses_model ON council_responses(model_id);
CREATE INDEX idx_council_responses_status ON council_responses(status);
```

### 2.2 Modified Tables

#### `messages` - Add council reference

```sql
-- Add to existing messages table
ALTER TABLE messages ADD COLUMN council_run_id TEXT DEFAULT NULL REFERENCES council_runs(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN is_council_synthesis BOOLEAN DEFAULT 0;

CREATE INDEX idx_messages_council_run ON messages(council_run_id);
```

### 2.3 Default Council Configurations (Seeded)

```sql
-- Insert default council configurations
INSERT INTO council_members (id, user_id, name, description, is_default, member_models, synthesizer_model) VALUES
('council-balanced', 'system', 'Balanced Council', 'A diverse panel of leading models for well-rounded answers', 1,
 '["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-pro-1.5"]',
 'anthropic/claude-3.5-sonnet'),

('council-research', 'system', 'Research Panel', 'Specialized for deep research and analysis', 1,
 '["anthropic/claude-3.5-sonnet", "anthropic/claude-3-opus", "openai/gpt-4o"]',
 'anthropic/claude-3-opus'),

('council-creative', 'system', 'Creative Collective', 'Diverse perspectives for creative tasks', 1,
 '["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "meta-llama/llama-3.1-70b-instruct"]',
 'anthropic/claude-3.5-sonnet'),

('council-verification', 'system', 'Fact Checkers', 'Multiple models for verification and accuracy', 1,
 '["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-pro-1.5", "perplexity/llama-3.1-sonar-large-128k-online"]',
 'anthropic/claude-3.5-sonnet');
```

---

## 3. Backend API Design

### 3.1 New Endpoints

#### POST `/api/chat/council` - Execute council query

**Request Body:**
```typescript
interface CouncilChatRequest {
  conversation_id: string;
  content: string;
  council_member_id?: string; // Use saved configuration
  council_config?: CouncilConfig; // Or provide inline config
  attachments?: ChatAttachmentInput[];
  pdf_engine?: PDFEngine;
  timezone?: string;
  invoke_agent_id?: string;
}

interface CouncilConfig {
  member_models: string[]; // e.g., ["anthropic/claude-3.5-sonnet", "openai/gpt-4o"]
  synthesizer_model: string;
  synthesis_prompt_template?: string;
}
```

**Response:** SSE Stream with events:

```typescript
// Phase 1: Council member progress
type CouncilMemberStartEvent = {
  type: 'council_member_start';
  member_index: number;
  model_id: string;
  total_members: number;
};

type CouncilMemberProgressEvent = {
  type: 'council_member_progress';
  member_index: number;
  model_id: string;
  chunk?: string; // Streaming chunk from this member (optional)
};

type CouncilMemberCompleteEvent = {
  type: 'council_member_complete';
  member_index: number;
  model_id: string;
  status: 'success' | 'error' | 'timeout';
  tokens_used?: number;
  cost?: number;
  response_time_ms?: number;
};

// Phase 2: Synthesis
type CouncilSynthesisStartEvent = {
  type: 'council_synthesis_start';
  synthesizer_model: string;
  successful_members: number;
  failed_members: number;
};

type CouncilSynthesisChunkEvent = {
  type: 'council_synthesis_chunk';
  content: string;
};

// Phase 3: Completion
type CouncilCompleteEvent = {
  type: 'council_complete';
  council_run_id: string;
  message_id: string;
  total_cost: number;
  total_tokens: number;
  synthesis_tokens: number;
  synthesis_cost: number;
};

type CouncilErrorEvent = {
  type: 'council_error';
  error: string;
  phase: 'execution' | 'synthesis' | 'storage';
};
```

**Implementation Flow:**

```typescript
// server/routes/chatCouncil.ts
router.post('/', async (req: AuthRequest, res: Response) => {
  // 1. Validate request and load conversation/agent
  // 2. Create council_run record
  // 3. Save user message
  // 4. Execute parallel model calls with Promise.allSettled()
  // 5. Stream member progress events
  // 6. Store all member responses
  // 7. Execute synthesis model with aggregated outputs
  // 8. Stream synthesis chunks
  // 9. Save final message with council_run_id
  // 10. Update council_run status and metrics
});
```

#### GET `/api/council/runs` - List council runs for conversation

```typescript
interface CouncilRunListItem {
  id: string;
  status: 'running' | 'completed' | 'partial_failure' | 'failed';
  member_count: number;
  successful_members: number;
  failed_members: number;
  total_cost: number;
  total_tokens: number;
  created_at: string;
  message_preview: string;
}

// GET /api/council/runs?conversation_id=xxx
```

#### GET `/api/council/runs/:id` - Get detailed council run

```typescript
interface CouncilRunDetail {
  id: string;
  status: string;
  synthesizer_model: string;
  member_count: number;
  total_cost: number;
  total_tokens: number;
  started_at: string;
  completed_at?: string;
  responses: CouncilResponseDetail[];
  synthesis_message?: Message;
}

interface CouncilResponseDetail {
  id: string;
  model_id: string;
  content: string;
  reasoning_content?: string;
  tokens_used: number;
  cost: number;
  response_time_ms: number;
  status: string;
  error_message?: string;
  display_order: number;
}
```

#### GET/POST/PUT/DELETE `/api/council/members` - CRUD for council configurations

```typescript
// Standard CRUD for CouncilMember entities
// GET /api/council/members - List user's saved councils + defaults
// POST /api/council/members - Create custom council
// PUT /api/council/members/:id - Update council
// DELETE /api/council/members/:id - Delete custom council
```

### 3.2 Core Service: CouncilExecutor

```typescript
// server/services/councilExecutor.ts

export interface CouncilExecutionOptions {
  conversationId: string;
  userId: string;
  content: string;
  memberModels: string[];
  synthesizerModel: string;
  systemPrompt: string;
  messageHistory: Message[];
  attachments?: ChatAttachmentInput[];
  pdfEngine?: PDFEngine;
  onMemberStart: (index: number, modelId: string) => void;
  onMemberProgress: (index: number, modelId: string, chunk?: string) => void;
  onMemberComplete: (index: number, result: MemberResult) => void;
  onSynthesisStart: (modelId: string, memberResults: MemberResult[]) => void;
  onSynthesisChunk: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface MemberResult {
  modelId: string;
  content: string;
  reasoningContent?: string;
  tokensUsed: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  responseTimeMs: number;
  status: 'success' | 'error' | 'timeout';
  errorMessage?: string;
}

export class CouncilExecutor {
  async execute(options: CouncilExecutionOptions): Promise<CouncilResult> {
    // Phase 1: Execute all members in parallel
    const memberPromises = options.memberModels.map((modelId, index) =>
      this.executeMember(modelId, index, options)
    );

    const memberResults = await Promise.allSettled(memberPromises);

    // Phase 2: Synthesize results
    const synthesis = await this.synthesize(memberResults, options);

    return {
      memberResults,
      synthesis,
      totalCost: this.calculateTotalCost(memberResults, synthesis),
      totalTokens: this.calculateTotalTokens(memberResults, synthesis),
    };
  }

  private async executeMember(
    modelId: string,
    index: number,
    options: CouncilExecutionOptions
  ): Promise<MemberResult> {
    // Individual model execution with timeout
    // Stream chunks if configured
    // Return structured result
  }

  private async synthesize(
    memberResults: PromiseSettledResult<MemberResult>[],
    options: CouncilExecutionOptions
  ): Promise<SynthesisResult> {
    // Build synthesis prompt from member outputs
    // Stream from synthesizer model
    // Return synthesis result
  }
}
```

---

## 4. Streaming Strategy

### 4.1 Multi-Phase Streaming Protocol

The council uses a single SSE stream with distinct phases:

```
STREAM PHASES:
═══════════════════════════════════════════════════════════════

PHASE 1: MEMBER EXECUTION (Parallel, progress aggregated)
─────────────────────────────────────────────────────────────
data: {"type":"council_member_start","member_index":0,"model_id":"anthropic/claude-3.5-sonnet","total_members":3}
data: {"type":"council_member_start","member_index":1,"model_id":"openai/gpt-4o","total_members":3}
data: {"type":"council_member_start","member_index":2,"model_id":"google/gemini-pro-1.5","total_members":3}

data: {"type":"council_member_complete","member_index":1,"model_id":"openai/gpt-4o","status":"success","tokens_used":452,"cost":0.0023}
data: {"type":"council_member_complete","member_index":2,"model_id":"google/gemini-pro-1.5","status":"success","tokens_used":389,"cost":0.0018}
data: {"type":"council_member_complete","member_index":0,"model_id":"anthropic/claude-3.5-sonnet","status":"success","tokens_used":512,"cost":0.0031}

PHASE 2: SYNTHESIS
─────────────────────────────────────────────────────────────
data: {"type":"council_synthesis_start","synthesizer_model":"anthropic/claude-3.5-sonnet","successful_members":3,"failed_members":0}

data: {"type":"council_synthesis_chunk","content":"Based on the collective analysis"}
data: {"type":"council_synthesis_chunk","content":" of all three models, I can provide"}
data: {"type":"council_synthesis_chunk","content":" you with a comprehensive answer..."}

PHASE 3: COMPLETION
─────────────────────────────────────────────────────────────
data: {"type":"council_complete","council_run_id":"run_xxx","message_id":"msg_xxx","total_cost":0.0082,"total_tokens":1453,"synthesis_tokens":512,"synthesis_cost":0.0020}
data: [DONE]
```

### 4.2 Client-Side Stream Processing

```typescript
// src/api/councilClient.ts

export async function streamCouncilChat(
  request: CouncilChatRequest,
  handlers: CouncilStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${API_BASE}/chat/council`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const event = parseCouncilEvent(line);
      if (!event) continue;

      switch (event.type) {
        case 'council_member_start':
          handlers.onMemberStart?.(event);
          break;
        case 'council_member_complete':
          handlers.onMemberComplete?.(event);
          break;
        case 'council_synthesis_start':
          handlers.onSynthesisStart?.(event);
          break;
        case 'council_synthesis_chunk':
          handlers.onSynthesisChunk?.(event.content);
          break;
        case 'council_complete':
          handlers.onComplete?.(event);
          return;
        case 'council_error':
          handlers.onError?.(event.error);
          return;
      }
    }
  }
}
```

### 4.3 Timeout & Cancellation Strategy

| Phase | Timeout | Behavior |
|-------|---------|----------|
| Individual member | 60s | Mark as timeout, continue with other members |
| Synthesis | 120s | Return error, but preserve member responses |
| Total council | 300s | Hard timeout, return partial results |

---

## 5. Frontend UI/UX Design

### 5.1 Component Architecture

```
ModelCouncilFeature
├── CouncilToggle (in ChatView toolbar)
├── CouncilSelectorModal (select/ configure council)
│   ├── CouncilCard (preset or custom)
│   └── CouncilBuilder (create custom)
├── CouncilStreamingView (active council streaming)
│   ├── CouncilProgressPanel (member progress)
│   └── CouncilSynthesisPanel (synthesis streaming)
└── CouncilMessageBubble (rendered council result)
    ├── CouncilSynthesisContent
    ├── CouncilMembersAccordion (individual responses)
    └── CouncilMetricsBar (cost, tokens, timing)
```

### 5.2 Council Toggle Component

Located in the ChatView toolbar, next to the Reasoning toggle:

```typescript
// src/components/CouncilToggle.tsx

interface CouncilToggleProps {
  isActive: boolean;
  onToggle: () => void;
  selectedCouncilId: string | null;
  onSelectCouncil: (councilId: string) => void;
  disabled?: boolean;
}

// Visual design:
// - Icon: Users or GitMerge (representing multiple models)
// - Active state: Purple/violet accent color
// - Badge: Shows number of members (e.g., "3")
// - Click: Opens council selector modal
```

**Visual Design:**
```
┌─────────────────────────────────────┐
│  [Brain] Think  │  [Users] Council  │  [Model]
│                 │     3 models      │  Selector
└─────────────────────────────────────┘
         ↑
    Council Toggle
    - Shows member count when active
    - Purple/violet when enabled
    - Dropdown on click for quick selection
```

### 5.3 Council Selector Modal

```typescript
// src/components/CouncilSelectorModal.tsx

interface CouncilSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (councilId: string) => void;
  onCreateCustom: () => void;
}
```

**Design:**
```
┌─────────────────────────────────────────────────────────┐
│  Model Council                              [X]         │
├─────────────────────────────────────────────────────────┤
│  Select a panel of AI models to answer together         │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  DEFAULT PANELS                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [⚖️] Balanced Council                    [Select]│   │
│  │     Claude 3.5 Sonnet + GPT-4o + Gemini Pro 1.5  │   │
│  │     Well-rounded answers from diverse models     │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [🔬] Research Panel                      [Select]│   │
│  │     Claude 3.5 Sonnet + Claude 3 Opus + GPT-4o   │   │
│  │     Deep research and analysis                   │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [✨] Creative Collective                 [Select]│   │
│  │     Claude 3.5 Sonnet + GPT-4o + Llama 3.1 70B   │   │
│  │     Diverse perspectives for creative tasks      │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  YOUR CUSTOM PANELS                                     │
│  [+ Create Custom Panel...]                             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 5.4 Council Streaming View

During execution, the UI shows:

```
┌─────────────────────────────────────────────────────────┐
│  Model Council is deliberating...                       │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 2/3 complete          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [✓] Claude 3.5 Sonnet        512 tokens  $0.0031       │
│  [✓] GPT-4o                   452 tokens  $0.0023       │
│  [⟳] Gemini Pro 1.5           responding...             │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  Synthesizing responses...                              │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━                           │
│  Based on the collective analysis of all three models...│
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 5.5 Council Message Bubble

The final rendered message shows synthesis with expandable member responses:

```
┌─────────────────────────────────────────────────────────┐
│  Assistant                    [Council: 3 models] [💰]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Based on the collective analysis of all three models,  │
│  here is a comprehensive answer to your question...     │
│                                                         │
│  [The synthesized response content goes here...]        │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  📊 Individual Model Responses                    [▼]   │
│  ─────────────────────────────────────────────────────  │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [●] Claude 3.5 Sonnet                    [View] │   │
│  │     512 tokens · $0.0031 · 2.3s                 │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [●] GPT-4o                               [View] │   │
│  │     452 tokens · $0.0023 · 1.8s                 │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [●] Gemini Pro 1.5                       [View] │   │
│  │     389 tokens · $0.0018 · 2.1s                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  💰 Total: $0.0082  |  📝 1,353 tokens  |  ⏱️ 3.2s      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 5.6 Custom Council Builder

```typescript
// src/components/CouncilBuilder.tsx

interface CouncilBuilderProps {
  initialConfig?: Partial<CouncilConfig>;
  onSave: (config: CouncilConfig) => void;
  onCancel: () => void;
}
```

**Design:**
```
┌─────────────────────────────────────────────────────────┐
│  Create Custom Panel                          [X]       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Panel Name                                             │
│  [My Research Panel                           ]         │
│                                                         │
│  Description (optional)                                 │
│  [Specialized for technical research...        ]        │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  Select Models (2-5 models recommended)                 │
│                                                         │
│  [Search models...                              ]       │
│                                                         │
│  Selected Models:                                       │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [●] anthropic/claude-3.5-sonnet          [Remove]│   │
│  │     Context: 200K · $3/M input · $15/M output    │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [●] openai/gpt-4o                        [Remove]│   │
│  │     Context: 128K · $5/M input · $15/M output    │   │
│  └─────────────────────────────────────────────────┘   │
│  [+ Add another model...]                               │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  Synthesizer Model                                      │
│  [Claude 3.5 Sonnet ▼]                                  │
│  The model that will combine all responses              │
│                                                         │
│  [Cancel]                                    [Save]     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 6. Synthesis Strategy & Prompt Engineering

### 6.1 Synthesis Prompt Template

```typescript
// server/prompts/councilSynthesis.ts

export const COUNCIL_SYNTHESIS_PROMPT = `You are a synthesis expert. Your task is to analyze multiple AI model responses to the same query and create a unified, comprehensive answer.

## Input Format
You will receive responses from {{member_count}} different AI models. Each response includes:
- Model name and version
- The full response content
- Any reasoning/thinking provided

## Your Task
1. **Analyze all responses** for:
   - Areas of agreement (consensus)
   - Areas of disagreement or different perspectives
   - Unique insights from individual models
   - Factual discrepancies that need resolution

2. **Synthesize a unified response** that:
   - Presents the most accurate and complete answer
   - Acknowledges different perspectives where relevant
   - Resolves contradictions using your best judgment
   - Maintains a professional, helpful tone
   - Cites which models contributed key insights (e.g., "According to Claude...")

3. **Structure your response** with:
   - A clear, direct answer to the query
   - Supporting details and context
   - Any important caveats or limitations
   - Optional: Brief note on model consensus

## Response Guidelines
- Be concise but thorough
- Do not simply concatenate responses
- Do not present conflicting information without resolution
- When models disagree, explain the different viewpoints and provide your synthesized conclusion
- Use markdown formatting for readability

## Input Responses
{{member_responses}}

Now provide your synthesized response:`;

interface SynthesisPromptParams {
  memberCount: number;
  memberResponses: {
    modelId: string;
    modelName: string;
    content: string;
    reasoningContent?: string;
  }[];
  userQuery: string;
}

export function buildSynthesisPrompt(
  template: string,
  params: SynthesisPromptParams
): string {
  const memberResponsesText = params.memberResponses
    .map((r, i) => `
### Response ${i + 1}: ${r.modelName} (${r.modelId})
${r.reasoningContent ? `**Reasoning:**\n${r.reasoningContent}\n\n` : ''}**Response:**
${r.content}
---
`)
    .join('\n');

  return template
    .replace('{{member_count}}', String(params.memberCount))
    .replace('{{member_responses}}', memberResponsesText)
    .replace('{{user_query}}', params.userQuery);
}
```

### 6.2 Alternative Synthesis Strategies

#### Strategy A: Hierarchical Synthesis (Default)
- All member responses go to a single synthesizer model
- Best for: General use, up to 5 members
- Pros: Simple, coherent output
- Cons: Context window limitations with many members

#### Strategy B: Tiered Synthesis (Future)
- First tier: Members grouped by capability/approach
- Second tier: Group synthesizers feed into final synthesizer
- Best for: 6+ members, very complex queries
- Pros: Scalable, maintains coherence
- Cons: More complex, higher latency

#### Strategy C: Debate Format (Future)
- Synthesizer presents multiple viewpoints without forcing consensus
- Best for: Subjective questions, creative tasks
- Pros: Preserves diversity of thought
- Cons: May not provide clear answer

### 6.3 Synthesizer Model Selection

| Use Case | Recommended Synthesizer | Rationale |
|----------|------------------------|-----------|
| General/Balanced | Claude 3.5 Sonnet | Excellent synthesis, good context window |
| Deep Research | Claude 3 Opus | Best reasoning for complex synthesis |
| Speed Priority | GPT-4o-mini | Fast, cost-effective |
| Creative Tasks | Claude 3.5 Sonnet | Good at blending creative perspectives |

---

## 7. Configuration & User Preferences

### 7.1 User Settings Integration

Add to existing settings system:

```typescript
// src/types/index.ts additions

interface CouncilUserSettings {
  // Default council to use (null = none, manual selection each time)
  default_council_id: string | null;

  // Default behavior
  auto_expand_member_responses: boolean;
  show_cost_in_message: boolean;
  show_timing_in_message: boolean;

  // Custom councils (stored separately in council_members table)
}
```

### 7.2 Settings UI

Add section to Settings modal:

```
┌─────────────────────────────────────────────────────────┐
│  Settings                                     [X]       │
├─────────────────────────────────────────────────────────┤
│  [General] [Models] [Tools] [MCP] [Council] [Account]   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  MODEL COUNCIL                                          │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Default Council Panel                                  │
│  [Balanced Council ▼]                                   │
│  The panel used when you enable Council mode            │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  Display Options                                        │
│                                                         │
│  [✓] Show individual model responses expanded           │
│  [✓] Show cost breakdown in messages                    │
│  [✓] Show response timing in messages                   │
│  [ ] Stream individual model responses (slower)         │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  Your Custom Panels                                     │
│  ┌─────────────────────────────────────────────────┐   │
│  │ My Tech Panel                             [Edit]│   │
│  │ 3 models · Created Jan 15, 2025                 │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Creative Writers                          [Edit]│   │
│  │ 4 models · Created Jan 10, 2025                 │   │
│  └─────────────────────────────────────────────────┘   │
│  [+ Create New Panel]                                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 8. Edge Cases & Error Handling

### 8.1 Partial Failure Scenarios

| Scenario | Behavior |
|----------|----------|
| 1 of 3 members fails | Continue with 2 members, note failure in synthesis |
| 2 of 3 members fail | Continue with 1 member, show warning |
| All members fail | Return error, suggest retry or single model |
| Synthesizer fails | Show individual member responses with note |
| Timeout on member | Mark as timeout, continue with others |
| Rate limit on member | Retry once, then mark as failed |

### 8.2 Error Messages

```typescript
const COUNCIL_ERROR_MESSAGES = {
  MEMBER_TIMEOUT: (modelId: string) =>
    `${formatModelId(modelId)} took too long to respond. Continuing with other models.`,

  MEMBER_ERROR: (modelId: string, error: string) =>
    `${formatModelId(modelId)} encountered an error: ${error}`,

  PARTIAL_SUCCESS: (successCount: number, totalCount: number) =>
    `Council completed with ${successCount}/${totalCount} models responding.`,

  SYNTHESIS_FAILED: 'Unable to synthesize responses. Showing individual model outputs.',

  ALL_FAILED: 'All council members failed to respond. Please try again or use a single model.',

  CONTEXT_OVERFLOW: 'Combined responses too large for synthesis. Summarizing individual outputs.',
};
```

### 8.3 Fallback Behavior

```typescript
// In synthesis phase, if context window exceeded:
async function handleContextOverflow(
  memberResults: MemberResult[],
  options: CouncilExecutionOptions
): Promise<SynthesisResult> {
  // Strategy: Summarize each member response first
  const summaries = await Promise.all(
    memberResults.map(r =>
      summarizeResponse(r.content, r.modelId, options.signal)
    )
  );

  // Then synthesize summaries
  return synthesizeSummaries(summaries, options);
}
```

---

## 9. Caching Strategy

### 9.1 Response Caching

Cache individual member responses to avoid redundant API calls:

```typescript
// server/services/councilCache.ts

interface CacheKey {
  queryHash: string; // SHA-256 of normalized query
  modelId: string;
  systemPromptHash: string;
  historyHash: string;
}

interface CachedResponse {
  content: string;
  reasoningContent?: string;
  tokensUsed: number;
  cachedAt: Date;
  ttl: number; // Time-to-live in seconds
}

// Cache configuration
const CACHE_CONFIG = {
  // Cache successful responses for 1 hour
  DEFAULT_TTL: 60 * 60 * 1000,

  // Don't cache if query contains time-sensitive terms
  SKIP_CACHE_PATTERNS: [
    /\bnow\b/i,
    /\btoday\b/i,
    /\bcurrent\b/i,
    /\blatest\b/i,
    /\bnews\b/i,
    /\bprice\b/i,
    /\bstock\b/i,
  ],

  // Max cache size per user
  MAX_ENTRIES_PER_USER: 100,
};
```

### 9.2 Cache Implementation

Use SQLite for persistent caching:

```sql
CREATE TABLE council_response_cache (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cache_key TEXT NOT NULL UNIQUE, -- Hash of query+model+context
  model_id TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning_content TEXT,
  tokens_used INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  hit_count INTEGER DEFAULT 0
);

CREATE INDEX idx_cache_key ON council_response_cache(cache_key);
CREATE INDEX idx_cache_expires ON council_response_cache(expires_at);
CREATE INDEX idx_cache_user ON council_response_cache(user_id);
```

### 9.3 Cache Invalidation

- **Time-based**: Automatic expiration after TTL
- **User-initiated**: Clear cache button in settings
- **Smart invalidation**: Clear cache when user explicitly requests fresh response

---

## 10. Migration Strategy

### 10.1 Database Migration

Add to existing `migrate()` function in `server/db.ts`:

```typescript
// Add after existing migrations in server/db.ts

function migrateCouncilTables() {
  // Create council_runs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS council_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      synthesizer_model TEXT NOT NULL DEFAULT 'anthropic/claude-3.5-sonnet',
      member_count INTEGER NOT NULL DEFAULT 3,
      system_prompt TEXT,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'partial_failure', 'failed')) DEFAULT 'running',
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      total_cost REAL DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      total_prompt_tokens INTEGER DEFAULT 0,
      total_completion_tokens INTEGER DEFAULT 0,
      failed_members INTEGER DEFAULT 0,
      error_log TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_council_runs_user ON council_runs(user_id);
    CREATE INDEX IF NOT EXISTS idx_council_runs_conversation ON council_runs(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_council_runs_message ON council_runs(message_id);
    CREATE INDEX IF NOT EXISTS idx_council_runs_status ON council_runs(status);
  `);

  // Create council_members table
  db.exec(`
    CREATE TABLE IF NOT EXISTS council_members (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      is_default INTEGER DEFAULT 0,
      member_models TEXT NOT NULL,
      synthesizer_model TEXT NOT NULL DEFAULT 'anthropic/claude-3.5-sonnet',
      synthesis_prompt_template TEXT,
      auto_expand_reasoning INTEGER DEFAULT 0,
      show_member_responses INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_council_members_user ON council_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_council_members_default ON council_members(is_default) WHERE is_default = 1;
  `);

  // Create council_responses table
  db.exec(`
    CREATE TABLE IF NOT EXISTS council_responses (
      id TEXT PRIMARY KEY,
      council_run_id TEXT NOT NULL REFERENCES council_runs(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      content TEXT NOT NULL,
      reasoning_content TEXT,
      tokens_used INTEGER DEFAULT 0,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      response_time_ms INTEGER,
      status TEXT NOT NULL CHECK(status IN ('success', 'error', 'timeout', 'cancelled')) DEFAULT 'success',
      error_message TEXT,
      display_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_council_responses_run ON council_responses(council_run_id);
    CREATE INDEX IF NOT EXISTS idx_council_responses_model ON council_responses(model_id);
    CREATE INDEX IF NOT EXISTS idx_council_responses_status ON council_responses(status);
  `);

  // Add council_run_id to messages
  const msgCols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!msgCols.some((c) => c.name === 'council_run_id')) {
    db.exec("ALTER TABLE messages ADD COLUMN council_run_id TEXT DEFAULT NULL REFERENCES council_runs(id) ON DELETE SET NULL");
    db.exec("ALTER TABLE messages ADD COLUMN is_council_synthesis INTEGER DEFAULT 0");
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_council_run ON messages(council_run_id)");
  }

  // Create cache table
  db.exec(`
    CREATE TABLE IF NOT EXISTS council_response_cache (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      cache_key TEXT NOT NULL UNIQUE,
      model_id TEXT NOT NULL,
      content TEXT NOT NULL,
      reasoning_content TEXT,
      tokens_used INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      hit_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_cache_key ON council_response_cache(cache_key);
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON council_response_cache(expires_at);
    CREATE INDEX IF NOT EXISTS idx_cache_user ON council_response_cache(user_id);
  `);

  // Seed default councils if none exist
  const defaultCount = db.prepare("SELECT COUNT(*) as cnt FROM council_members WHERE is_default = 1").get() as { cnt: number };
  if (defaultCount.cnt === 0) {
    seedDefaultCouncils();
  }
}

function seedDefaultCouncils() {
  const defaults = [
    {
      id: 'council-balanced',
      name: 'Balanced Council',
      description: 'A diverse panel of leading models for well-rounded answers',
      models: '["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-pro-1.5"]',
    },
    {
      id: 'council-research',
      name: 'Research Panel',
      description: 'Specialized for deep research and analysis',
      models: '["anthropic/claude-3.5-sonnet", "anthropic/claude-3-opus", "openai/gpt-4o"]',
    },
    {
      id: 'council-creative',
      name: 'Creative Collective',
      description: 'Diverse perspectives for creative tasks',
      models: '["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "meta-llama/llama-3.1-70b-instruct"]',
    },
  ];

  const stmt = db.prepare(`
    INSERT INTO council_members (id, user_id, name, description, is_default, member_models, synthesizer_model)
    VALUES (?, 'system', ?, ?, 1, ?, 'anthropic/claude-3.5-sonnet')
  `);

  for (const council of defaults) {
    stmt.run(council.id, council.name, council.description, council.models);
  }
}
```

### 10.2 Backward Compatibility

- Existing messages without `council_run_id` render normally
- API endpoint `/api/chat` remains unchanged
- Council is opt-in per message via new endpoint

---

## 11. Implementation Order

### Phase 1: Core Infrastructure (Week 1)
1. Database migrations (tables, indexes)
2. Type definitions (TypeScript interfaces)
3. CouncilExecutor service (parallel execution)
4. Basic synthesis prompt

### Phase 2: Backend API (Week 1-2)
1. POST `/api/chat/council` endpoint
2. Council streaming implementation
3. Error handling and partial failure logic
4. GET endpoints for council runs
5. CRUD endpoints for council members

### Phase 3: Frontend Components (Week 2)
1. CouncilToggle component
2. CouncilSelectorModal component
3. CouncilBuilder component
4. CouncilMessageBubble component
5. Council streaming state management

### Phase 4: Integration & Polish (Week 3)
1. Integration with existing ChatView
2. Settings panel integration
3. Caching implementation
4. Edge case handling
5. Performance optimization

### Phase 5: Testing & Documentation (Week 3-4)
1. Unit tests for CouncilExecutor
2. Integration tests for API
3. Frontend component tests
4. Documentation updates

---

## 12. Verification Criteria

### 12.1 Functional Requirements

- [ ] User can enable/disable council mode per message
- [ ] User can select from preset council configurations
- [ ] User can create custom council configurations
- [ ] Council executes across multiple models in parallel
- [ ] Synthesized response streams to UI in real-time
- [ ] Individual member responses are viewable
- [ ] Costs and tokens are tracked for all members + synthesis
- [ ] Partial failures are handled gracefully
- [ ] Council runs are persisted and viewable historically

### 12.2 Performance Requirements

- [ ] Council execution completes within 3x single-model time (parallel benefit)
- [ ] UI remains responsive during council execution
- [ ] Streaming synthesis begins within 2 seconds of last member completion
- [ ] Memory usage scales linearly with member count

### 12.3 Quality Requirements

- [ ] Synthesized responses are coherent and accurate
- [ ] UI clearly indicates when council mode is active
- [ ] Error messages are helpful and actionable
- [ ] Cost transparency is clear (total + breakdown)
- [ ] Design matches existing "Obsidian Atelier" aesthetic

### 12.4 Test Scenarios

1. **Happy Path**: 3 models, all succeed, synthesis works
2. **Partial Failure**: 1 of 3 models fails
3. **Total Failure**: All models fail
4. **Synthesis Failure**: Members succeed but synthesis fails
5. **Cancellation**: User cancels mid-execution
6. **Timeout**: One model times out
7. **Large Response**: Members return very long responses
8. **Custom Council**: User creates and uses custom council

---

## Appendix A: File Structure

```
server/
├── routes/
│   ├── chat.ts                    # Existing
│   ├── chatCouncil.ts             # NEW: Council chat endpoint
│   └── councilMembers.ts          # NEW: Council CRUD endpoints
├── services/
│   ├── councilExecutor.ts         # NEW: Core execution logic
│   ├── councilSynthesis.ts        # NEW: Synthesis engine
│   └── councilCache.ts            # NEW: Response caching
├── prompts/
│   └── councilSynthesis.ts        # NEW: Synthesis prompts
└── db.ts                          # MODIFIED: Add migrations

src/
├── components/
│   ├── ChatView.tsx               # MODIFIED: Add council toggle
│   ├── MessageBubble.tsx          # MODIFIED: Handle council messages
│   ├── CouncilToggle.tsx          # NEW
│   ├── CouncilSelectorModal.tsx   # NEW
│   ├── CouncilBuilder.tsx         # NEW
│   ├── CouncilStreamingView.tsx   # NEW
│   └── CouncilMessageBubble.tsx   # NEW
├── hooks/
│   ├── useChat.ts                 # MODIFIED: Add council support
│   └── useCouncil.ts              # NEW
├── api/
│   ├── client.ts                  # MODIFIED: Add council client
│   └── councilClient.ts           # NEW
├── stores/
│   └── store.ts                   # MODIFIED: Add council state
└── types/
    └── index.ts                   # MODIFIED: Add council types
```

---

## Appendix B: Cost Estimation

Example cost breakdown for a typical council query:

| Component | Model | Input Tokens | Output Tokens | Cost |
|-----------|-------|--------------|---------------|------|
| Member 1 | Claude 3.5 Sonnet | 2,000 | 500 | $0.0030 |
| Member 2 | GPT-4o | 2,000 | 450 | $0.0028 |
| Member 3 | Gemini Pro 1.5 | 2,000 | 400 | $0.0015 |
| Synthesizer | Claude 3.5 Sonnet | 3,500 | 600 | $0.0045 |
| **Total** | | **9,500** | **1,950** | **$0.0118** |

Compared to single model (Claude 3.5 Sonnet): ~$0.0030
Council overhead: ~4x for significantly improved answer quality.

---

*Document Version: 1.0*
*Last Updated: 2025-02-15*
*Author: Senior Software Architect*
