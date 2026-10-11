import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Config } from "../config.js";

export type ChatTurn = [question: string, answer: string];
/** route: emergency | crisis | medicine | plan_answer | referral | clarify | other | medication_mistake */
export interface ChatReply { text: string; route: string; quotes: string[] }
export interface ChatProvider { readonly name: string; ask(planMarkdown: string, question: string, history: ChatTurn[]): Promise<ChatReply> }

/**
 * The AI-Infra patient chatbot (patient_agents/chatbot.py) over a JSON bridge. It answers only from
 * the patient's Going-Home Plan: emergencies go to 911/988 in code, "should I take X" is decided in
 * code from the plan's medicine lists, and any other answer is used only when the plan lines it
 * quotes really are in the plan; everything else is "please call your nurse or doctor".
 */
export class AiInfraChat implements ChatProvider {
  readonly name = "ai-infra";
  constructor(private readonly config: Config) {}
  ask(planMarkdown: string, question: string, history: ChatTurn[]): Promise<ChatReply> {
    return new Promise((resolveReply, reject) => {
      const child = spawn(this.config.PYTHON_EXECUTABLE, ["-m", "patient_agents.chat_bridge"], {
        cwd: resolve(import.meta.dirname, "../../../AI-Infra"), shell: false,
        env: { ...process.env, DISCHARGEAI_AWS_PROFILE: process.env.AWS_PROFILE ?? "", DISCHARGEAI_AWS_REGION: this.config.AWS_REGION, PYTHONIOENCODING: "utf-8" },
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = ""; let error = "";
      const timeout = setTimeout(() => { child.kill(); reject(new Error("The plan assistant timed out")); }, this.config.CHAT_TIMEOUT_MS);
      child.stdout.on("data", data => { output += data; if (output.length > 200_000) child.kill(); });
      child.stderr.on("data", data => { error = (error + data).slice(-4000); });
      child.stdin.on("error", () => {});
      child.once("error", err => { clearTimeout(timeout); reject(err); });
      child.once("close", code => {
        clearTimeout(timeout);
        if (code !== 0) { reject(new Error(/AccessDenied|ExpiredToken|UnrecognizedClient/.test(error) ? "AWS denied the plan assistant or credentials expired" : "The plan assistant failed; check Python dependencies and model access")); return; }
        try {
          const reply = JSON.parse(output) as ChatReply;
          if (typeof reply.text !== "string" || typeof reply.route !== "string" || !Array.isArray(reply.quotes)) throw new Error("Invalid assistant response");
          resolveReply(reply);
        } catch (err) { reject(err); }
      });
      child.stdin.end(JSON.stringify({ plan: planMarkdown, question, history }));
    });
  }
}
