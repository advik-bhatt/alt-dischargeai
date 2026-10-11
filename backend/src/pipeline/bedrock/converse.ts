import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type Message,
  type ToolChoice,
} from "@aws-sdk/client-bedrock-runtime";
import type { ZodType } from "zod";
import type { Logger } from "../../logger.js";
import type { LlmUsage } from "../types.js";

/**
 * Amazon Bedrock Converse with tool-based structured JSON. Verified live in this account on
 * 2026-10-10 with us.anthropic.claude-sonnet-4-6 (forced toolChoice) and
 * us.anthropic.claude-haiku-4-5-20251001-v1:0 (auto toolChoice + system line).
 *
 * Flow: one tool whose inputSchema.json is our zod schema -> the model must call it -> read
 * toolUse.input -> validate with zod -> on failure send the issues back as a toolResult error and
 * ask once more -> on second failure throw. Credentials come from the standard AWS chain only.
 */
export interface ConverseJsonOptions<T> {
  client: BedrockRuntimeClient;
  modelId: string;
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  jsonSchema: Record<string, unknown>;
  schema: ZodType<T>;
  maxTokens?: number;
  temperature?: number;
  log?: Logger;
}

export interface ConverseJsonResult<T> {
  data: T;
  usage: LlmUsage;
  latencyMs: number;
  attempts: number;
  toolChoice: "tool" | "auto";
  stopReason?: string;
}

export function createBedrockClient(region: string): BedrockRuntimeClient {
  return new BedrockRuntimeClient({ region });
}

function isToolChoiceRejected(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? "").toLowerCase();
  return (err as { name?: string })?.name === "ValidationException" && /tool_?choice/.test(msg);
}

export async function converseJson<T>(opts: ConverseJsonOptions<T>): Promise<ConverseJsonResult<T>> {
  const t0 = Date.now();
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const messages: Message[] = [{ role: "user", content: [{ text: opts.user }] }];
  let toolChoice: "tool" | "auto" = "tool";
  let attempts = 0;
  let lastIssues = "";
  let stopReason: string | undefined;

  const send = async (choice: ToolChoice) => {
    const input: ConverseCommandInput = {
      modelId: opts.modelId,
      system: [{ text: `${opts.system}\nAlways answer by calling the tool ${opts.toolName} exactly once.` }],
      messages,
      inferenceConfig: { maxTokens: opts.maxTokens ?? 4096, temperature: opts.temperature ?? 0 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: opts.toolName,
              description: opts.toolDescription,
              inputSchema: { json: opts.jsonSchema as never },
            },
          },
        ],
        toolChoice: choice,
      },
    };
    return opts.client.send(new ConverseCommand(input));
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    let res;
    try {
      res = await send(toolChoice === "tool" ? { tool: { name: opts.toolName } } : { auto: {} });
    } catch (err) {
      if (toolChoice === "tool" && isToolChoiceRejected(err)) {
        opts.log?.warn({ modelId: opts.modelId }, "forced toolChoice rejected; falling back to auto + system line");
        toolChoice = "auto";
        res = await send({ auto: {} });
      } else {
        throw err;
      }
    }
    usage.inputTokens = (usage.inputTokens ?? 0) + (res.usage?.inputTokens ?? 0);
    usage.outputTokens = (usage.outputTokens ?? 0) + (res.usage?.outputTokens ?? 0);
    usage.totalTokens = (usage.totalTokens ?? 0) + (res.usage?.totalTokens ?? 0);
    stopReason = res.stopReason;

    const content: ContentBlock[] = res.output?.message?.content ?? [];
    const block = content.find((c) => "toolUse" in c && c.toolUse) as ContentBlock.ToolUseMember | undefined;
    if (!block?.toolUse) {
      const text = content.map((c) => ("text" in c ? c.text : "")).join("").slice(0, 400);
      lastIssues = `no tool call in response (stopReason=${res.stopReason}); text was: ${text}`;
      messages.push({ role: "assistant", content: content.length ? content : [{ text: "(empty)" }] });
      messages.push({
        role: "user",
        content: [{ text: `You did not call the tool ${opts.toolName}. Call it now, exactly once, with the complete result.` }],
      });
      continue;
    }

    const parsed = opts.schema.safeParse(block.toolUse.input);
    if (parsed.success) {
      return { data: parsed.data, usage, latencyMs: Date.now() - t0, attempts, toolChoice, stopReason };
    }
    lastIssues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    opts.log?.warn({ attempt, issueCount: parsed.error.issues.length }, "tool input failed validation; retrying once");
    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: block.toolUse.toolUseId,
            status: "error",
            content: [{ text: `Validation failed: ${lastIssues}. Call ${opts.toolName} again with a corrected, complete result.` }],
          },
        },
      ],
    });
  }
  throw new Error(`Bedrock Converse returned invalid structured output after ${attempts} attempts: ${lastIssues}`);
}
