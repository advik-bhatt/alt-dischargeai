import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { AiOutputSchema, aiOutputJsonSchema } from "../../contracts/aiOutput.js";
import { TRANSLATE_SYSTEM_PROMPT, TRANSLATE_TOOL_NAME, translateUserMessage } from "../prompts.js";
import type { TranslateInput, TranslateResult, Translator } from "../types.js";
import { converseJson, createBedrockClient } from "./converse.js";
import type { BedrockOptions } from "./simplify.js";

/** "Translate (Spanish, Mandarin, Arabic)": one Converse call per language, field by field, names and doses verbatim. */
export class BedrockTranslator implements Translator {
  readonly name = "bedrock";
  private readonly client: BedrockRuntimeClient;
  private readonly jsonSchema = aiOutputJsonSchema();

  constructor(private readonly opts: BedrockOptions) {
    this.client = opts.client ?? createBedrockClient(opts.region);
  }

  async translate(input: TranslateInput): Promise<TranslateResult> {
    const r = await converseJson({
      client: this.client,
      modelId: this.opts.modelId,
      system: TRANSLATE_SYSTEM_PROMPT,
      user: translateUserMessage(JSON.stringify(input.english, null, 2), input.languageName, input.language),
      toolName: TRANSLATE_TOOL_NAME,
      toolDescription: "Emit the translated structured instructions in the same fixed JSON contract.",
      jsonSchema: this.jsonSchema,
      schema: AiOutputSchema,
      maxTokens: 4096,
      temperature: 0,
      log: this.opts.log,
    });
    return { output: { ...r.data, language: input.language }, provider: this.name, model: this.opts.modelId, usage: r.usage, latencyMs: r.latencyMs };
  }
}
