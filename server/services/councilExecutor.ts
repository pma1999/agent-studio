import { nanoid } from 'nanoid';
import type {
  CouncilExecutionOptions,
  MemberResult,
  SynthesisResult,
  CouncilResult,
  ToolCallSpec,
} from '../types.js';
import { runTool, toOpenRouterTools } from '../tools/index.js';

const MEMBER_TIMEOUT_MS = 240000; // 4 minutes per member
const SYNTHESIS_TIMEOUT_MS = 240000; // 4 minutes for synthesis
const MAX_RETRIES = 1;

interface StreamChunk {
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCallSpec[];
}

export class CouncilExecutor {
  private apiKey: string;
  private apiUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
  }

  async execute(options: CouncilExecutionOptions): Promise<CouncilResult> {
    const startTime = Date.now();
    const synthesizerModel = options.synthesizerModel || 'anthropic/claude-3.5-sonnet';

    console.log(`\n🏛️  COUNCIL EXECUTION STARTED`);
    console.log(`   📊 Members: ${options.memberModels.length}`);
    console.log(`   🎯 Models: ${options.memberModels.map(m => m.split('/').pop()).join(', ')}`);
    console.log(`   🧠 Synthesizer: ${synthesizerModel.split('/').pop()}`);
    console.log(`   💬 Query: "${options.content.slice(0, 80)}${options.content.length > 80 ? '...' : ''}"`);
    console.log(`   🔧 Tools: ${options.tools?.length || 0}, MCPs: ${options.mcpClients?.size || 0}`);
    console.log('');

    // Phase 1: Execute all members in parallel with individual timeouts
    const memberPromises = options.memberModels.map((modelId, index) =>
      this.executeMemberWithTimeout(modelId, index, options)
    );

    const memberResultsSettled = await Promise.allSettled(memberPromises);

    // Convert settled results to MemberResult[]
    const memberResults: MemberResult[] = memberResultsSettled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.log(`   ❌ Member ${index + 1} FAILED: ${options.memberModels[index].split('/').pop()} - ${errorMsg}`);
        return {
          modelId: options.memberModels[index],
          content: '',
          tokensUsed: 0,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          cost: 0,
          responseTimeMs: 0,
          status: 'error',
          errorMessage: errorMsg,
        };
      }
    });

    // Log member summary
    const successCount = memberResults.filter(r => r.status === 'success').length;
    const errorCount = memberResults.filter(r => r.status === 'error').length;
    const timeoutCount = memberResults.filter(r => r.status === 'timeout').length;

    console.log(`\n📊 MEMBER EXECUTION SUMMARY`);
    console.log(`   ✅ Success: ${successCount} | ❌ Errors: ${errorCount} | ⏱️ Timeouts: ${timeoutCount}`);
    memberResults.forEach((r, i) => {
      const modelName = r.modelId.split('/').pop();
      const icon = r.status === 'success' ? '✅' : r.status === 'timeout' ? '⏱️' : '❌';
      const details = r.status === 'success'
        ? `${r.tokensUsed?.toLocaleString() || 0} tokens, $${(r.cost || 0).toFixed(4)}, ${((r.responseTimeMs || 0) / 1000).toFixed(1)}s`
        : r.errorMessage?.slice(0, 40) || 'Unknown error';
      console.log(`   ${icon} [${i + 1}] ${modelName}: ${details}`);
    });

    // Phase 2: Synthesize results
    const synthesis = await this.synthesize(memberResults, options);

    const totalTime = Date.now() - startTime;
    const totalCost = this.calculateTotalCost(memberResults, synthesis);
    const totalTokens = this.calculateTotalTokens(memberResults, synthesis);

    // Final summary
    console.log(`\n🏁 COUNCIL EXECUTION COMPLETE`);
    console.log(`   ⏱️  Total Time: ${(totalTime / 1000).toFixed(2)}s`);
    console.log(`   💰 Total Cost: $${totalCost.toFixed(4)}`);
    console.log(`   📝 Total Tokens: ${totalTokens.toLocaleString()}`);
    console.log(`   🧠 Synthesis: ${synthesis.tokensUsed?.toLocaleString() || 0} tokens, $${(synthesis.cost || 0).toFixed(4)}, ${((synthesis.responseTimeMs || 0) / 1000).toFixed(1)}s`);
    console.log(`   📄 Response Length: ${synthesis.content?.length || 0} chars`);
    console.log('');

    return {
      memberResults,
      synthesis,
      totalCost,
      totalTokens,
    };
  }

  private async executeMemberWithTimeout(
    modelId: string,
    index: number,
    options: CouncilExecutionOptions
  ): Promise<MemberResult> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout after ${MEMBER_TIMEOUT_MS}ms`));
      }, MEMBER_TIMEOUT_MS);

      this.executeMember(modelId, index, options)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  private async executeMember(
    modelId: string,
    index: number,
    options: CouncilExecutionOptions
  ): Promise<MemberResult> {
    const startTime = Date.now();
    const modelName = modelId.split('/').pop() || modelId;

    console.log(`   🚀 [${index + 1}/${options.memberModels.length}] Starting: ${modelName}`);

    // Notify start
    options.onMemberStart(index, modelId);

    let retries = 0;
    let lastError: Error | null = null;

    while (retries <= MAX_RETRIES) {
      try {
        const result = await this.executeMemberStream(modelId, index, options);
        const responseTimeMs = Date.now() - startTime;

        // Notify completion
        const memberResult: MemberResult = {
          ...result,
          responseTimeMs,
          status: 'success',
        };
        options.onMemberComplete(index, memberResult);

        const hasTools = result.toolCalls && result.toolCalls.length > 0;
        console.log(`   ✅ [${index + 1}] Complete: ${modelName} | ${result.tokensUsed?.toLocaleString() || 0} tokens | $${(result.cost || 0).toFixed(4)} | ${(responseTimeMs / 1000).toFixed(1)}s${hasTools ? ` | 🔧 ${result.toolCalls?.length} tools` : ''}`);

        return { ...result, responseTimeMs, status: 'success' };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retries++;

        if (retries <= MAX_RETRIES) {
          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
        }
      }
    }

    const responseTimeMs = Date.now() - startTime;
    const failedResult: MemberResult = {
      modelId,
      content: '',
      tokensUsed: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cost: 0,
      responseTimeMs,
      status: lastError?.message?.includes('Timeout') ? 'timeout' : 'error',
      errorMessage: lastError?.message || 'Unknown error',
    };

    const statusIcon = failedResult.status === 'timeout' ? '⏱️' : '❌';
    console.log(`   ${statusIcon} [${index + 1}] Failed: ${modelName} | ${failedResult.status} | ${failedResult.errorMessage?.slice(0, 50)}${failedResult.errorMessage && failedResult.errorMessage.length > 50 ? '...' : ''}`);

    options.onMemberComplete(index, failedResult);
    return failedResult;
  }

  private async executeMemberStream(
    modelId: string,
    index: number,
    options: CouncilExecutionOptions
  ): Promise<Omit<MemberResult, 'responseTimeMs' | 'status'>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'http://localhost:5173',
      'X-Title': 'Agent Studio',
    };

    // Build messages
    const messages: Array<{ role: string; content?: string | unknown[] | null; tool_call_id?: string; tool_calls?: unknown[] }> = [
      { role: 'system', content: options.systemPrompt },
      ...options.messageHistory,
    ];

    // Handle attachments for the last user message
    if (options.attachments && options.attachments.length > 0) {
      const lastIdx = messages.length - 1;
      if (lastIdx >= 0 && messages[lastIdx].role === 'user') {
        const textPart = { type: 'text' as const, text: options.content };
        const fileParts = options.attachments.map((a) => ({
          type: 'file' as const,
          file: {
            filename: a.filename,
            file_data: a.file_data ?? a.url,
          },
        }));
        (messages[lastIdx] as Record<string, unknown>).content = [textPart, ...fileParts];
      }
    }

    // Resolve tools
    const resolvedTools = options.tools || [];
    const openRouterTools = toOpenRouterTools(resolvedTools);

    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
      stream: true,
    };

    if (openRouterTools.length > 0) {
      requestBody.tools = openRouterTools;
      requestBody.tool_choice = 'auto';
      requestBody.parallel_tool_calls = true;
    }

    if (options.pdfEngine) {
      requestBody.plugins = [{ id: 'file-parser', pdf: { engine: options.pdfEngine } }];
    }

    // Handle tool calling loop
    let iteration = 0;
    const MAX_TOOL_ITERATIONS = 5;
    let fullContent = '';
    let fullReasoning = '';
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let cost = 0;
    let finalToolCalls: ToolCallSpec[] = [];

    while (iteration < MAX_TOOL_ITERATIONS) {
      if (options.signal?.aborted) {
        throw new Error('Execution cancelled');
      }

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: options.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error (${response.status}): ${errorText}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const toolCallsByIndex: Record<number, { id?: string; type?: string; function?: { name?: string; arguments?: string } }> = {};
      let lastFinishReason: string | null = null;

      try {
        while (true) {
          if (options.signal?.aborted) {
            reader.cancel().catch(() => {});
            throw new Error('Execution cancelled');
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(': ') || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') break;

            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                throw new Error(parsed.error.message || 'Stream error');
              }

              const delta = parsed.choices?.[0]?.delta;

              if (delta?.reasoning || delta?.reasoning_content) {
                fullReasoning += delta.reasoning || delta.reasoning_content;
              }
              if (delta?.content) {
                fullContent += delta.content;
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsByIndex[idx]) toolCallsByIndex[idx] = {};
                  if (tc.id) toolCallsByIndex[idx].id = tc.id;
                  if (tc.type) toolCallsByIndex[idx].type = tc.type;
                  if (tc.function) {
                    toolCallsByIndex[idx].function = toolCallsByIndex[idx].function || {};
                    if (tc.function.name) toolCallsByIndex[idx].function!.name = tc.function.name;
                    if (tc.function.arguments) {
                      toolCallsByIndex[idx].function!.arguments = (toolCallsByIndex[idx].function!.arguments || '') + tc.function.arguments;
                    }
                  }
                }
              }

              const usage = parsed.usage;
              if (usage) {
                totalTokens = usage.total_tokens ?? totalTokens;
                promptTokens = usage.prompt_tokens ?? promptTokens;
                completionTokens = usage.completion_tokens ?? completionTokens;
                if (usage.cost !== undefined) cost = usage.cost;
                if (usage.completion_tokens_details?.reasoning_tokens) {
                  reasoningTokens = usage.completion_tokens_details.reasoning_tokens;
                }
              }

              const fr = parsed.choices?.[0]?.finish_reason;
              if (fr && fr !== 'null') lastFinishReason = fr;
            } catch {
              // Skip malformed
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      // Handle tool calls
      if (lastFinishReason === 'tool_calls' && resolvedTools.length > 0) {
        const indices = Object.keys(toolCallsByIndex).map(Number).sort((a, b) => a - b);
        const toolCallsArray: ToolCallSpec[] = indices.map((idx) => ({
          id: toolCallsByIndex[idx].id || `call_${nanoid()}`,
          type: (toolCallsByIndex[idx].type || 'function') as 'function',
          function: {
            name: toolCallsByIndex[idx].function?.name || '',
            arguments: toolCallsByIndex[idx].function?.arguments || '{}',
          },
        })).filter((tc) => tc.function.name);

        if (toolCallsArray.length === 0) break;

        messages.push({
          role: 'assistant',
          content: fullContent || null,
          tool_calls: toolCallsArray,
        });

        // Execute tools
        console.log(`      🔧 Executing ${toolCallsArray.length} tool call(s) for ${modelId.split('/').pop()}...`);
        for (const tc of toolCallsArray) {
          const name = tc.function.name;
          const argsStr = tc.function.arguments || '{}';
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(argsStr);
          } catch {
            args = {};
          }

          const result = await runTool(
            resolvedTools as unknown as Parameters<typeof runTool>[0],
            name,
            args,
            options.mcpClients || new Map(),
            options.userId
          );

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result.output,
          });
        }

        console.log(`      ✅ Tools completed for ${modelId.split('/').pop()}, continuing conversation...`);
        finalToolCalls = [...finalToolCalls, ...toolCallsArray];
        iteration++;
        continue;
      }

      break;
    }

    return {
      modelId,
      content: fullContent,
      reasoningContent: fullReasoning || undefined,
      tokensUsed: totalTokens,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cost,
      toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
    };
  }

  private async synthesize(
    memberResults: MemberResult[],
    options: CouncilExecutionOptions
  ): Promise<SynthesisResult> {
    const startTime = Date.now();
    const synthesizerModel = options.synthesizerModel || 'anthropic/claude-3.5-sonnet';

    // Filter successful results
    const successfulResults = memberResults.filter((r) => r.status === 'success' && r.content);

    if (successfulResults.length === 0) {
      console.log(`   ❌ No successful member results to synthesize`);
      throw new Error('No successful member results to synthesize');
    }

    // Build synthesis prompt
    const synthesisPrompt = this.buildSynthesisPrompt(successfulResults, options.content);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'http://localhost:5173',
      'X-Title': 'Agent Studio',
    };

    const requestBody = {
      model: synthesizerModel,
      messages: [
        { role: 'system', content: 'You are a synthesis expert. Your task is to analyze multiple AI model responses and create a unified, comprehensive answer.' },
        { role: 'user', content: synthesisPrompt },
      ],
      temperature: 0.7,
      max_tokens: 4096,
      stream: true,
    };

    // Notify synthesis start
    console.log(`\n🧠 SYNTHESIS STARTED`);
    console.log(`   🎯 Model: ${synthesizerModel.split('/').pop()}`);
    console.log(`   📊 Input: ${successfulResults.length} successful responses`);
    console.log(`   🤖 Sources: ${successfulResults.map(r => r.modelId.split('/').pop()).join(', ')}`);

    options.onSynthesisStart(
      synthesizerModel,
      successfulResults
    );

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`   ❌ Synthesis API Error: ${response.status} - ${errorText.slice(0, 100)}`);
      throw new Error(`Synthesis API error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error('No synthesis response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let fullReasoning = '';
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cost = 0;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Synthesis timeout')), SYNTHESIS_TIMEOUT_MS);
    });

    const streamPromise = (async () => {
      try {
        while (true) {
          if (options.signal?.aborted) {
            reader.cancel().catch(() => {});
            throw new Error('Synthesis cancelled');
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(': ') || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') break;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;

              if (delta?.reasoning || delta?.reasoning_content) {
                fullReasoning += delta.reasoning || delta.reasoning_content;
              }
              if (delta?.content) {
                fullContent += delta.content;
                options.onSynthesisChunk(delta.content);
              }

              const usage = parsed.usage;
              if (usage) {
                totalTokens = usage.total_tokens ?? totalTokens;
                promptTokens = usage.prompt_tokens ?? promptTokens;
                completionTokens = usage.completion_tokens ?? completionTokens;
                if (usage.cost !== undefined) cost = usage.cost;
              }
            } catch {
              // Skip malformed
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    })();

    await Promise.race([streamPromise, timeoutPromise]);

    const responseTimeMs = Date.now() - startTime;

    console.log(`   ✅ Synthesis Complete: ${totalTokens.toLocaleString()} tokens | $${(cost || 0).toFixed(4)} | ${(responseTimeMs / 1000).toFixed(1)}s`);

    return {
      content: fullContent,
      reasoningContent: fullReasoning || undefined,
      tokensUsed: totalTokens,
      promptTokens,
      completionTokens,
      cost,
      responseTimeMs,
    };
  }

  private buildSynthesisPrompt(memberResults: MemberResult[], userQuery: string): string {
    const memberResponsesText = memberResults
      .map((r, i) => {
        const modelName = r.modelId.split('/').pop() || r.modelId;
        return `
### Response ${i + 1}: ${modelName}
${r.reasoningContent ? `**Reasoning Process:**
${r.reasoningContent}

` : ''}**Response:**
${r.content}
---
`;
      })
      .join('\n');

    return `You are a synthesis expert. Your task is to analyze multiple AI model responses to the same query and create a unified, comprehensive answer.

## Original Query
"""${userQuery}"""

## Input Responses
You will receive responses from ${memberResults.length} different AI models:

${memberResponsesText}

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
   - Cites which models contributed key insights when relevant

3. **Structure your response** with:
   - A clear, direct answer to the query
   - Supporting details and context
   - Any important caveats or limitations

## Response Guidelines
- Be concise but thorough
- Do not simply concatenate responses
- Do not present conflicting information without resolution
- When models disagree, explain the different viewpoints and provide your synthesized conclusion
- Use markdown formatting for readability

Now provide your synthesized response:`;
  }

  private calculateTotalCost(memberResults: MemberResult[], synthesis: SynthesisResult): number {
    const memberCost = memberResults.reduce((sum, r) => sum + (r.cost || 0), 0);
    return memberCost + (synthesis.cost || 0);
  }

  private calculateTotalTokens(memberResults: MemberResult[], synthesis: SynthesisResult): number {
    const memberTokens = memberResults.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);
    return memberTokens + (synthesis.tokensUsed || 0);
  }
}

export function createCouncilExecutor(apiKey: string): CouncilExecutor {
  return new CouncilExecutor(apiKey);
}
