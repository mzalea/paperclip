import { formatCents, formatTokens } from "./utils";

export interface ApiEquivalentAmounts {
  costCents: number;
  apiEquivalentCents: number;
  apiEquivalentUnpricedTokens: number;
}

export interface SpendDisplay {
  /** the amount to show as the headline figure */
  primaryCents: number;
  /** the other figure, as a footnote; null when it adds nothing */
  note: string | null;
}

/**
 * Which spend figure leads. With the instance's showApiEquivalentCosts setting
 * on, the API-rate cost leads and billed spend becomes the footnote; off, the
 * billed spend leads and the API-rate cost is the footnote.
 */
export function spendDisplay(amounts: ApiEquivalentAmounts, showApiEquivalent: boolean): SpendDisplay {
  const unpriced = amounts.apiEquivalentUnpricedTokens > 0
    ? `${formatTokens(amounts.apiEquivalentUnpricedTokens)} unpriced tok`
    : null;
  const differs = amounts.apiEquivalentCents !== amounts.costCents;
  if (showApiEquivalent) {
    const billed = differs ? `${formatCents(amounts.costCents)} billed` : null;
    return {
      primaryCents: amounts.apiEquivalentCents,
      note: [billed, unpriced ? `+ ${unpriced}` : null].filter(Boolean).join(" ") || null,
    };
  }
  if (!differs && !unpriced) return { primaryCents: amounts.costCents, note: null };
  return {
    primaryCents: amounts.costCents,
    note: `≈ ${formatCents(amounts.apiEquivalentCents)} at API rates${unpriced ? ` + ${unpriced}` : ""}`,
  };
}
