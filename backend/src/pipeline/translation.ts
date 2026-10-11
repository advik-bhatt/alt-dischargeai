import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { DischargePlan, Language } from "../../../frontend/src/data.js";
import type { Config } from "../config.js";

export interface TranslationResult { plan: DischargePlan; status: "verified" | "needs_review"; problems: string[] }
export interface TranslationProvider { readonly name: string; translate(plan: DischargePlan, lang: Exclude<Language, "en">): Promise<TranslationResult> }

export class AiInfraTranslator implements TranslationProvider {
  readonly name = "ai-infra";
  constructor(private readonly config: Config) {}
  translate(plan: DischargePlan, lang: Exclude<Language, "en">): Promise<TranslationResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(this.config.PYTHON_EXECUTABLE, ["-m", "patient_agents.web_bridge"], {
        cwd: resolve(import.meta.dirname, "../../../AI-Infra"), shell: false,
        env: { ...process.env, DISCHARGEAI_AWS_PROFILE: process.env.AWS_PROFILE ?? "", DISCHARGEAI_AWS_REGION: this.config.AWS_REGION, PYTHONIOENCODING: "utf-8" },
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = ""; let error = "";
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Translation timed out")); }, this.config.TRANSLATION_TIMEOUT_MS);
      child.stdout.on("data", data => { output += data; if (output.length > 2_000_000) child.kill(); });
      child.stderr.on("data", data => { error = (error + data).slice(-4000); });
      child.stdin.on("error", () => {});
      child.once("error", err => { clearTimeout(timeout); reject(err); });
      child.once("close", code => {
        clearTimeout(timeout);
        if (code !== 0) { reject(new Error(/AccessDenied|ExpiredToken|UnrecognizedClient/.test(error) ? "AWS denied translation access or credentials expired" : "AI-Infra translation failed; check Python dependencies and model access")); return; }
        try {
          const result = JSON.parse(output) as TranslationResult;
          if (!["verified", "needs_review"].includes(result.status) || !result.plan?.medications || !Array.isArray(result.problems)) throw new Error("Invalid translation response");
          resolveResult(result);
        } catch (err) { reject(err); }
      });
      child.stdin.end(JSON.stringify({ plan, lang }));
    });
  }
}
