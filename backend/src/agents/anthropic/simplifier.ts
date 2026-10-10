import type Anthropic from "@anthropic-ai/sdk";
import { SIMPLIFY_SYSTEM_PROMPT, simplifyUserMessage } from "../prompts/simplify.js";
import type { SimplifierAgent, SimplifyInput, SimplifyResult } from "../simplifier.js";
import { SimplifiedSummarySchema, simplifiedSummaryJsonSchema } from "../types.js";
import { anthropicJson, createAnthropicClient, type AnthropicAgentOptions } from "./client.js";

/** LLM_PROVIDER=anthropic: direct Claude API with JSON-schema structured output. Needs a key. */
export class AnthropicSimplifier implements SimplifierAgent {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly jsonSchema = simplifiedSummaryJsonSchema();

  constructor(private readonly opts: AnthropicAgentOptions) {
    this.client = opts.client ?? createAnthropicClient(opts.apiKey);
  }

  async simplify(input: SimplifyInput): Promise<SimplifyResult> {
    const r = await anthropicJson({
      client: this.client,
      model: this.opts.model,
      system: SIMPLIFY_SYSTEM_PROMPT.replace(/Always answer by calling the tool \S+ exactly once[^\n]*/, "Answer with the JSON object only."),
      user: simplifyUserMessage(input.text, input.language),
      jsonSchema: this.jsonSchema,
      schema: SimplifiedSummarySchema,
      log: this.opts.log,
    });
    return { summary: r.data, provider: this.name, model: this.opts.model, usage: r.usage, latencyMs: r.latencyMs };
  }
}
