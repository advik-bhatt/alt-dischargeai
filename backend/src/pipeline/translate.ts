import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { TranslateInput, TranslateResult, Translator } from "./types.js";

export type { TranslateInput, TranslateResult, Translator } from "./types.js";

/** LLM_PROVIDER=bedrock | anthropic, same switch as the simplifier. */
export async function createTranslator(config: Config, log: Logger): Promise<Translator> {
  switch (config.LLM_PROVIDER) {
    case "bedrock": {
      const { BedrockTranslator } = await import("./bedrock/translate.js");
      return new BedrockTranslator({ modelId: config.BEDROCK_MODEL_ID, region: config.AWS_REGION, log });
    }
    case "anthropic": {
      const { AnthropicTranslator } = await import("./anthropic/translate.js");
      return new AnthropicTranslator({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL, log });
    }
    default:
      throw new Error(`Unknown LLM_PROVIDER "${config.LLM_PROVIDER}"`);
  }
}
