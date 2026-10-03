// Reference API list prices, used only to show what subscription usage would
// have cost at metered API rates. Never used for billing or budgets.
//
// Prices are USD per million tokens. `inputIncludesCached` records whether the
// adapter's inputTokens already contains cachedInputTokens (Codex reports it
// that way; Claude reports uncached input separately). Cache writes are not
// tracked in cost_events, so token-priced Claude estimates undercount them; a
// run's own reported costUsd is preferred over this table when present.

export interface ModelPrice {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  inputIncludesCached: boolean;
}

export const API_EQUIVALENT_PRICES_AS_OF = "2026-10-03";

const anthropic = (input: number, cachedInput: number, output: number): ModelPrice => ({
  inputPerMillion: input,
  cachedInputPerMillion: cachedInput,
  outputPerMillion: output,
  inputIncludesCached: false,
});

const openai = (input: number, cachedInput: number, output: number): ModelPrice => ({
  inputPerMillion: input,
  cachedInputPerMillion: cachedInput,
  outputPerMillion: output,
  inputIncludesCached: true,
});

const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": anthropic(10, 0.25, 50),
  "claude-opus-5-5": anthropic(4, 0.2, 20),
  "claude-opus-5": anthropic(5, 0.5, 25),
  "claude-sonnet-5": anthropic(2, 0.2, 10),
  "claude-haiku-4-5": anthropic(1, 0.1, 5),
  // Promotional rate through 2026-11-21; list price is 5 / 0.50 / 30.
  "gpt-5.6-sol": openai(4, 0.4, 20),
};

export function lookupModelPrice(model: string): ModelPrice | null {
  return MODEL_PRICES[model.trim().toLowerCase()] ?? null;
}

/** Returns null when the model has no reference price. */
export function priceTokensUsd(
  model: string,
  tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
): number | null {
  const price = lookupModelPrice(model);
  if (!price) return null;
  const uncachedInput = price.inputIncludesCached
    ? Math.max(0, tokens.inputTokens - tokens.cachedInputTokens)
    : tokens.inputTokens;
  return (
    (uncachedInput * price.inputPerMillion +
      tokens.cachedInputTokens * price.cachedInputPerMillion +
      tokens.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}
