import type { OpenRouterEndpoint } from '../types';

/**
 * Coste combinado prompt + completion para ordenar determinísticamente.
 * Usa parseFloat con fallback 0 para tolerar strings inválidas.
 */
export function endpointCost(e: OpenRouterEndpoint): number {
  const prompt = parseFloat(e.pricing.prompt);
  const completion = parseFloat(e.pricing.completion);
  return (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0);
}

/**
 * Ordena endpoints por criterio determinístico del plan:
 *  cost asc → context_length desc → quantization localeCompare asc → uptime_last_5m desc (null=-1)
 */
export function cheapestEndpoints(endpoints: OpenRouterEndpoint[]): OpenRouterEndpoint[] {
  return [...endpoints].sort((a, b) => {
    const costDiff = endpointCost(a) - endpointCost(b);
    if (costDiff !== 0) return costDiff;
    const ctxDiff = (b.context_length ?? 0) - (a.context_length ?? 0);
    if (ctxDiff !== 0) return ctxDiff;
    const qa = a.quantization ?? '';
    const qb = b.quantization ?? '';
    if (qa !== qb) return qa.localeCompare(qb);
    const upA = a.uptime_last_5m ?? -1;
    const upB = b.uptime_last_5m ?? -1;
    return upB - upA;
  });
}

export function cheapestEndpoint(endpoints: OpenRouterEndpoint[]): OpenRouterEndpoint | null {
  if (endpoints.length === 0) return null;
  return cheapestEndpoints(endpoints)[0] ?? null;
}
