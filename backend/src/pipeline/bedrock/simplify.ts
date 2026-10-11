import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { AiOutputSchema, aiOutputJsonSchema } from "../../contracts/aiOutput.js";
import type { Logger } from "../../logger.js";
import { SIMPLIFY_SYSTEM_PROMPT, SIMPLIFY_TOOL_NAME, simplifyUserMessage } from "../prompts.js";
import type { Simplifier, SimplifyResult } from "../types.js";
import { converseJson, createBedrockClient } from "./converse.js";

export interface BedrockOptions {
  modelId: string;
  region: string;
  log?: Logger;
  client?: BedrockRuntimeClient;
}

/** "Jargon to plain language (Bedrock (Claude), 5th-grade reading level)": one Converse call with tool-based JSON. */
export class BedrockSimplifier implements Simplifier {
  readonly name = "bedrock";
  private readonly client: BedrockRuntimeClient;
  private readonly jsonSchema = aiOutputJsonSchema();

  constructor(private readonly opts: BedrockOptions) {
    this.client = opts.client ?? createBedrockClient(opts.region);
  }

  async simplify(input: { text: string }): Promise<SimplifyResult> {
    const r = await converseJson({
      client: this.client,
      modelId: this.opts.modelId,
      system: SIMPLIFY_SYSTEM_PROMPT,
      user: simplifyUserMessage(input.text),
      toolName: SIMPLIFY_TOOL_NAME,
      toolDescription: "Emit the plain-language discharge instructions as the fixed JSON contract.",
      jsonSchema: this.jsonSchema,
      schema: AiOutputSchema,
      maxTokens: 4096,
      temperature: 0,
      log: this.opts.log,
    });
    return { output: { ...r.data, language: "en" }, provider: this.name, model: this.opts.modelId, usage: r.usage, latencyMs: r.latencyMs };
  }
}
