import type { SimplifierAgent, SimplifyInput, SimplifyResult } from "../simplifier.js";
import { loadSimplifiedFixture, matchFixture } from "./fixtures.js";
import { ruleBasedSimplify } from "./rules.js";

/**
 * Deterministic simplifier: curated fixtures for the five hackathon examples (matched by fingerprint),
 * rule-based extraction for anything else. Runs the whole demo and the test suite with no keys.
 */
export class OfflineSimplifier implements SimplifierAgent {
  readonly name = "offline";

  async simplify(input: SimplifyInput): Promise<SimplifyResult> {
    const t0 = Date.now();
    const match = matchFixture(input.text);
    if (match) {
      return {
        summary: loadSimplifiedFixture(match.id),
        provider: this.name,
        model: `fixture:${match.id}`,
        fixture: match.id,
        latencyMs: Date.now() - t0,
      };
    }
    return {
      summary: ruleBasedSimplify(input.text),
      provider: this.name,
      model: "rules",
      latencyMs: Date.now() - t0,
    };
  }
}
