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

function isViableForCheapest(e: OpenRouterEndpoint): boolean {
  if (e.status !== null && e.status !== 0) return false;
  if (e.uptime_last_5m !== null && e.uptime_last_5m < 85) return false;
  if (e.uptime_last_30m !== null && e.uptime_last_30m < 85) return false;
  return true;
}

/**
 * Ordena endpoints por criterio determinístico del plan:
 *  cost asc → context_length desc → quantization localeCompare asc → uptime_last_5m desc (null=-1)
 * Para "El más barato" se filtra primero por viabilidad operativa (status y uptime >=85%);
 * si ningún endpoint es viable, se usa el pool completo para no dejar la CTA vacía.
 */
export function cheapestEndpoints(endpoints: OpenRouterEndpoint[]): OpenRouterEndpoint[] {
  const viable = endpoints.filter(isViableForCheapest);
  const pool = viable.length > 0 ? viable : endpoints;
  return [...pool].sort((a, b) => {
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
