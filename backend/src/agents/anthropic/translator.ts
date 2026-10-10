import type Anthropic from "@anthropic-ai/sdk";
import {
  BACK_TRANSLATE_SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
  backTranslateUserMessage,
  translateUserMessage,
} from "../prompts/translate.js";
import type { TranslateInput, TranslateResult, TranslatorAgent } from "../translator.js";
import { SimplifiedSummarySchema, simplifiedSummaryJsonSchema } from "../types.js";
import { anthropicJson, createAnthropicClient, type AnthropicAgentOptions } from "./client.js";

const asJsonOnly = (prompt: string) =>
  prompt.replace(/Always answer by calling the tool \S+ exactly once[^\n]*/, "Answer with the JSON object only.");

/** LLM_PROVIDER=anthropic translator: translate, then back-translate, both as JSON-schema outputs. Needs a key. */
export class AnthropicTranslator implements TranslatorAgent {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly jsonSchema = simplifiedSummaryJsonSchema();

  constructor(private readonly opts: AnthropicAgentOptions) {
    this.client = opts.client ?? createAnthropicClient(opts.apiKey);
  }

  async translate(input: TranslateInput): Promise<TranslateResult> {
    const t0 = Date.now();
    const forward = await anthropicJson({
      client: this.client,
      model: this.opts.model,
      system: asJsonOnly(TRANSLATE_SYSTEM_PROMPT),
      user: translateUserMessage(JSON.stringify(input.summary, null, 2), input.languageName, input.language),
      jsonSchema: this.jsonSchema,
      schema: SimplifiedSummarySchema,
      log: this.opts.log,
    });
    const back = await anthropicJson({
      client: this.client,
      model: this.opts.model,
      system: asJsonOnly(BACK_TRANSLATE_SYSTEM_PROMPT),
      user: backTranslateUserMessage(JSON.stringify(forward.data, null, 2), input.languageName),
      jsonSchema: this.jsonSchema,
      schema: SimplifiedSummarySchema,
      log: this.opts.log,
    });
    return {
      translation: { ...forward.data, language: input.language },
      backTranslation: back.data,
      provider: this.name,
      model: this.opts.model,
      usage: {
        inputTokens: (forward.usage.inputTokens ?? 0) + (back.usage.inputTokens ?? 0),
        outputTokens: (forward.usage.outputTokens ?? 0) + (back.usage.outputTokens ?? 0),
      },
      latencyMs: Date.now() - t0,
    };
  }
}
