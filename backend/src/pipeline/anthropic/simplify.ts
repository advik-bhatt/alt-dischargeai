import type Anthropic from "@anthropic-ai/sdk";
import { AiOutputSchema, aiOutputJsonSchema } from "../../contracts/aiOutput.js";
import { SIMPLIFY_SYSTEM_PROMPT, simplifyUserMessage } from "../prompts.js";
import type { Simplifier, SimplifyResult } from "../types.js";
import { anthropicJson, createAnthropicClient, type AnthropicAgentOptions } from "./client.js";

export const asJsonOnly = (prompt: string) => prompt.replace(/Always answer by calling the tool \S+ exactly once[^\n]*/, "Answer with the JSON object only.");

/** LLM_PROVIDER=anthropic: direct Claude API with JSON-schema structured output. Needs ANTHROPIC_API_KEY. */
export class AnthropicSimplifier implements Simplifier {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly jsonSchema = aiOutputJsonSchema();

  constructor(private readonly opts: AnthropicAgentOptions) {
    this.client = opts.client ?? createAnthropicClient(opts.apiKey);
  }

  async simplify(input: { text: string }): Promise<SimplifyResult> {
    const r = await anthropicJson({
      client: this.client,
      model: this.opts.model,
      system: asJsonOnly(SIMPLIFY_SYSTEM_PROMPT),
      user: simplifyUserMessage(input.text),
      jsonSchema: this.jsonSchema,
      schema: AiOutputSchema,
      log: this.opts.log,
    });
    return { output: { ...r.data, language: "en" }, provider: this.name, model: this.opts.model, usage: r.usage, latencyMs: r.latencyMs };
  }
}
