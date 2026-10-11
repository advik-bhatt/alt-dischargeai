import type Anthropic from "@anthropic-ai/sdk";
import { AiOutputSchema, aiOutputJsonSchema } from "../../contracts/aiOutput.js";
import { TRANSLATE_SYSTEM_PROMPT, translateUserMessage } from "../prompts.js";
import type { TranslateInput, TranslateResult, Translator } from "../types.js";
import { anthropicJson, createAnthropicClient, type AnthropicAgentOptions } from "./client.js";
import { asJsonOnly } from "./simplify.js";

/** LLM_PROVIDER=anthropic translator: one structured-output call per language. Needs ANTHROPIC_API_KEY. */
export class AnthropicTranslator implements Translator {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly jsonSchema = aiOutputJsonSchema();

  constructor(private readonly opts: AnthropicAgentOptions) {
    this.client = opts.client ?? createAnthropicClient(opts.apiKey);
  }

  async translate(input: TranslateInput): Promise<TranslateResult> {
    const r = await anthropicJson({
      client: this.client,
      model: this.opts.model,
      system: asJsonOnly(TRANSLATE_SYSTEM_PROMPT),
      user: translateUserMessage(JSON.stringify(input.english, null, 2), input.languageName, input.language),
      jsonSchema: this.jsonSchema,
      schema: AiOutputSchema,
      log: this.opts.log,
    });
    return { output: { ...r.data, language: input.language }, provider: this.name, model: this.opts.model, usage: r.usage, latencyMs: r.latencyMs };
  }
}
