import Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";
import type { Logger } from "../../logger.js";
import type { LlmUsage } from "../types.js";

/**
 * Direct Anthropic API with structured outputs (`output_config.format` json_schema). Needs
 * ANTHROPIC_API_KEY; not exercised in the hackathon container (no key), listed under "needs a key".
 */
export interface AnthropicAgentOptions {
  apiKey?: string;
  model: string;
  log?: Logger;
  client?: Anthropic;
}

export function createAnthropicClient(apiKey?: string): Anthropic {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for LLM_PROVIDER=anthropic");
  return new Anthropic({ apiKey });
}

export async function anthropicJson<T>(opts: {
  client: Anthropic;
  model: string;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  schema: ZodType<T>;
  maxTokens?: number;
  log?: Logger;
}): Promise<{ data: T; usage: LlmUsage; latencyMs: number }> {
  const t0 = Date.now();
  let lastIssues = "";
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.user }];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await opts.client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 8192,
      system: opts.system,
      messages,
      output_config: { format: { type: "json_schema", schema: opts.jsonSchema as never } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      lastIssues = "response was not valid JSON";
    }
    const parsed = raw === undefined ? undefined : opts.schema.safeParse(raw);
    if (parsed?.success) {
      return {
        data: parsed.data,
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        latencyMs: Date.now() - t0,
      };
    }
    if (parsed && !parsed.success) {
      lastIssues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    }
    opts.log?.warn({ attempt }, "anthropic structured output failed validation; retrying once");
    messages.push({ role: "assistant", content: text || "(empty)" });
    messages.push({ role: "user", content: `Validation failed: ${lastIssues}. Answer again with a corrected, complete JSON object.` });
  }
  throw new Error(`Anthropic structured output invalid after 2 attempts: ${lastIssues}`);
}
