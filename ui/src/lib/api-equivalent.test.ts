import { describe, expect, it } from "vitest";
import { spendDisplay } from "./api-equivalent";

const subscription = { costCents: 0, apiEquivalentCents: 1234, apiEquivalentUnpricedTokens: 0 };

describe("spendDisplay", () => {
  it("leads with billed spend and footnotes the API-rate cost when the setting is off", () => {
    expect(spendDisplay(subscription, false)).toEqual({ primaryCents: 0, note: "≈ $12.34 at API rates" });
  });

  it("leads with the API-rate cost and footnotes billed spend when the setting is on", () => {
    expect(spendDisplay(subscription, true)).toEqual({ primaryCents: 1234, note: "$0.00 billed" });
  });

  it("drops the footnote when billed spend already equals the API-rate cost", () => {
    const billed = { costCents: 500, apiEquivalentCents: 500, apiEquivalentUnpricedTokens: 0 };
    expect(spendDisplay(billed, false)).toEqual({ primaryCents: 500, note: null });
    expect(spendDisplay(billed, true)).toEqual({ primaryCents: 500, note: null });
  });

  it("names unpriced tokens either way", () => {
    const partial = { ...subscription, apiEquivalentUnpricedTokens: 2500 };
    expect(spendDisplay(partial, false).note).toBe("≈ $12.34 at API rates + 2.5k unpriced tok");
    expect(spendDisplay(partial, true).note).toBe("$0.00 billed + 2.5k unpriced tok");
  });
});
