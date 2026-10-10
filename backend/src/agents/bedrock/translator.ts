import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { Logger } from "../../logger.js";
import {
  BACK_TRANSLATE_SYSTEM_PROMPT,
  TRANSLATE_SYSTEM_PROMPT,
  TRANSLATE_TOOL_NAME,
  backTranslateUserMessage,
  translateUserMessage,
} from "../prompts/translate.js";
import type { TranslateInput, TranslateResult, TranslatorAgent } from "../translator.js";
import { SimplifiedSummarySchema, simplifiedSummaryJsonSchema } from "../types.js";
import { converseJson, createBedrockClient } from "./converse.js";
import type { BedrockAgentOptions } from "./simplifier.js";

/**
 * Default live translator: two Converse calls. The first translates the structure field by field with
 * medications verbatim; the second translates it back to English so the backend can diff numbers and
 * drug names (verify/backtranslate.ts).
 */
export class BedrockTranslator implements TranslatorAgent {
  readonly name = "bedrock";
  private readonly client: BedrockRuntimeClient;
  private readonly jsonSchema = simplifiedSummaryJsonSchema();

  constructor(private readonly opts: BedrockAgentOptions) {
    this.client = opts.client ?? createBedrockClient(opts.region);
  }

  async translate(input: TranslateInput): Promise<TranslateResult> {
    const t0 = Date.now();
    const forward = await converseJson({
      client: this.client,
      modelId: this.opts.modelId,
      system: TRANSLATE_SYSTEM_PROMPT,
      user: translateUserMessage(JSON.stringify(input.summary, null, 2), input.languageName, input.language),
      toolName: TRANSLATE_TOOL_NAME,
      toolDescription: "Emit the translated structured instructions.",
      jsonSchema: this.jsonSchema,
      schema: SimplifiedSummarySchema,
      maxTokens: 4096,
      temperature: 0,
      log: this.opts.log,
    });
    const back = await converseJson({
      client: this.client,
      modelId: this.opts.modelId,
      system: BACK_TRANSLATE_SYSTEM_PROMPT,
      user: backTranslateUserMessage(JSON.stringify(forward.data, null, 2), input.languageName),
      toolName: TRANSLATE_TOOL_NAME,
      toolDescription: "Emit the literal English back-translation of the structured instructions.",
      jsonSchema: this.jsonSchema,
      schema: SimplifiedSummarySchema,
      maxTokens: 4096,
      temperature: 0,
      log: this.opts.log,
    });
    const translation = { ...forward.data, language: input.language };
    return {
      translation,
      backTranslation: back.data,
      provider: this.name,
      model: this.opts.modelId,
      usage: {
        inputTokens: (forward.usage.inputTokens ?? 0) + (back.usage.inputTokens ?? 0),
        outputTokens: (forward.usage.outputTokens ?? 0) + (back.usage.outputTokens ?? 0),
        totalTokens: (forward.usage.totalTokens ?? 0) + (back.usage.totalTokens ?? 0),
      },
      latencyMs: Date.now() - t0,
    };
  }
}
