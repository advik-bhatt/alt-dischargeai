import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { Logger } from "../../logger.js";
import { SIMPLIFY_SYSTEM_PROMPT, SIMPLIFY_TOOL_NAME, simplifyUserMessage } from "../prompts/simplify.js";
import type { SimplifierAgent, SimplifyInput, SimplifyResult } from "../simplifier.js";
import { SimplifiedSummarySchema, simplifiedSummaryJsonSchema } from "../types.js";
import { converseJson, createBedrockClient } from "./converse.js";

export interface BedrockAgentOptions {
  modelId: string;
  region: string;
  log?: Logger;
  client?: BedrockRuntimeClient;
}

/** Default live simplifier: Claude on Amazon Bedrock via the Converse API with tool-based JSON. */
export class BedrockSimplifier implements SimplifierAgent {
  readonly name = "bedrock";
  private readonly client: BedrockRuntimeClient;
  private readonly jsonSchema = simplifiedSummaryJsonSchema();

  constructor(private readonly opts: BedrockAgentOptions) {
    this.client = opts.client ?? createBedrockClient(opts.region);
  }

  async simplify(input: SimplifyInput): Promise<SimplifyResult> {
    const r = await converseJson({
      client: this.client,
      modelId: this.opts.modelId,
      system: SIMPLIFY_SYSTEM_PROMPT,
      user: simplifyUserMessage(input.text, input.language),
      toolName: SIMPLIFY_TOOL_NAME,
      toolDescription: "Emit the simplified, plain-language discharge summary as structured JSON.",
      jsonSchema: this.jsonSchema,
      schema: SimplifiedSummarySchema,
      maxTokens: 4096,
      temperature: 0,
      log: this.opts.log,
    });
    return { summary: r.data, provider: this.name, model: this.opts.modelId, usage: r.usage, latencyMs: r.latencyMs };
  }
}
