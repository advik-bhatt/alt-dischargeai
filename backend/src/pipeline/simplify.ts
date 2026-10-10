import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { loadAiOutputFixture, matchFixture } from "./offline/fixtures.js";
import { ruleBasedSimplify } from "./offline/rules.js";
import type { Simplifier, SimplifyResult } from "./types.js";

export type { Simplifier, SimplifyResult } from "./types.js";

/**
 * Offline twin of "Jargon to plain language": curated fixtures for the five hackathon examples
 * (matched by fingerprint), rule-based extraction for anything else. Runs the demo and the tests
 * with no keys.
 */
export class OfflineSimplifier implements Simplifier {
  readonly name = "offline";

  async simplify(input: { text: string }): Promise<SimplifyResult> {
    const t0 = Date.now();
    const match = matchFixture(input.text);
    const fixture = match ? loadAiOutputFixture(match.id, "en") : undefined;
    if (match && fixture) {
      return { output: fixture, provider: this.name, model: `fixture:${match.id}`, fixture: match.id, latencyMs: Date.now() - t0 };
    }
    return { output: ruleBasedSimplify(input.text), provider: this.name, model: "rules", latencyMs: Date.now() - t0 };
  }
}

/** LLM_PROVIDER=bedrock (Claude on Amazon Bedrock, Converse API) | anthropic | offline. */
export async function createSimplifier(config: Config, log: Logger): Promise<Simplifier> {
  switch (config.LLM_PROVIDER) {
    case "bedrock": {
      const { BedrockSimplifier } = await import("./bedrock/simplify.js");
      return new BedrockSimplifier({ modelId: config.BEDROCK_MODEL_ID, region: config.AWS_REGION, log });
    }
    case "anthropic": {
      const { AnthropicSimplifier } = await import("./anthropic/simplify.js");
      return new AnthropicSimplifier({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL, log });
    }
    case "offline":
    default:
      return new OfflineSimplifier();
  }
}
