import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { LlmUsage, SimplifiedSummary } from "./types.js";

export interface TranslateInput {
  summary: SimplifiedSummary;
  /** Target language: BCP-47 code from GET /languages (e.g. "es"). */
  language: string;
  /** Human-readable name of the target language (e.g. "Spanish"). */
  languageName: string;
}

export interface TranslateResult {
  /** Same structure as the input, text in the target language, medication names and doses verbatim. */
  translation: SimplifiedSummary;
  /** The translation rendered back into English, so the backend can diff numbers and drug names. */
  backTranslation?: SimplifiedSummary;
  provider: string;
  model?: string;
  usage?: LlmUsage;
  latencyMs?: number;
  fixture?: string;
}

/**
 * Team integration contract for the translation agent. Same drop-in rule as SimplifierAgent:
 * one file, one class, one factory entry, one env value. Medication `name`, `dose` and `howOften`
 * numbers must come back verbatim; the backend checks and records any drift as warnings.
 */
export interface TranslatorAgent {
  readonly name: string;
  translate(input: TranslateInput): Promise<TranslateResult>;
}

export async function createTranslator(config: Config, log: Logger): Promise<TranslatorAgent> {
  switch (config.LLM_PROVIDER) {
    case "bedrock": {
      const { BedrockTranslator } = await import("./bedrock/translator.js");
      return new BedrockTranslator({ modelId: config.BEDROCK_MODEL_ID, region: config.AWS_REGION, log });
    }
    case "anthropic": {
      const { AnthropicTranslator } = await import("./anthropic/translator.js");
      return new AnthropicTranslator({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL, log });
    }
    case "offline":
    default: {
      const { OfflineTranslator } = await import("./offline/translator.js");
      return new OfflineTranslator();
    }
  }
}
