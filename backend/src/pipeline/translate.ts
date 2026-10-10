import type { AiOutput } from "../contracts/aiOutput.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { fixtureIdFor, loadAiOutputFixture } from "./offline/fixtures.js";
import type { TranslateInput, TranslateResult, Translator } from "./types.js";

export type { TranslateInput, TranslateResult, Translator } from "./types.js";

/**
 * Offline twin of "Translate": curated fixtures for Example 1 (es, zh, ar), a phrase dictionary for
 * Spanish on anything else, identity for English, and a visibly marked passthrough for other
 * languages. Medication names and doses are never touched.
 */
export class OfflineTranslator implements Translator {
  readonly name = "offline";

  async translate(input: TranslateInput): Promise<TranslateResult> {
    const t0 = Date.now();
    const fixtureId = fixtureIdFor(input.english);
    if (fixtureId) {
      const fixture = loadAiOutputFixture(fixtureId, input.language);
      if (fixture) {
        return { output: fixture, provider: this.name, model: `fixture:${fixtureId}.${input.language}`, fixture: `${fixtureId}.${input.language}`, latencyMs: Date.now() - t0 };
      }
    }
    if (input.language === "en") {
      return { output: structuredClone(input.english), provider: this.name, model: "identity", latencyMs: Date.now() - t0 };
    }
    if (input.language.split("-")[0] === "es") {
      return { output: mapStrings(input.english, spanishPhrases, input.language), provider: this.name, model: "dictionary:es", latencyMs: Date.now() - t0 };
    }
    return { output: mapStrings(input.english, (s) => `[${input.language}] ${s}`, input.language), provider: this.name, model: "passthrough", latencyMs: Date.now() - t0 };
  }
}

/** Applies fn to every patient-facing string; ids, status, tier and medication name/dose stay as they are. */
export function mapStrings(output: AiOutput, fn: (s: string) => string, language: string): AiOutput {
  return {
    language,
    steps: output.steps.map((s) => ({ id: s.id, text: fn(s.text) })),
    medications: output.medications.map((m) => ({ name: m.name, dose: m.dose, howOften: fn(m.howOften), status: m.status, why: fn(m.why) })),
    followUps: output.followUps.map((f) => ({ who: fn(f.who), when: fn(f.when), why: fn(f.why) })),
    warnings: output.warnings.map((w) => ({ text: fn(w.text), ...(w.tier ? { tier: w.tier } : {}) })),
  };
}

const ES: [RegExp, string][] = [
  [/\bonce a day by mouth\b/gi, "una vez al día por la boca"],
  [/\btwice a day by mouth\b/gi, "dos veces al día por la boca"],
  [/\bfour times a day\b/gi, "cuatro veces al día"],
  [/\bthree times a day\b/gi, "tres veces al día"],
  [/\btwice a day\b/gi, "dos veces al día"],
  [/\bonce a day\b/gi, "una vez al día"],
  [/\bevery night\b/gi, "cada noche"],
  [/\bevery morning\b/gi, "cada mañana"],
  [/\bevery day\b/gi, "todos los días"],
  [/\bby mouth\b/gi, "por la boca"],
  [/\bonly when needed\b/gi, "solo cuando sea necesario"],
  [/\bas needed\b/gi, "según sea necesario"],
  [/\bfor (\d+) more days\b/gi, "por $1 días más"],
  [/\bwithin about (\d+) week\b/gi, "dentro de aproximadamente $1 semana"],
  [/\bwithin (\d+) week\b/gi, "dentro de $1 semana"],
  [/\bas arranged\b/gi, "según lo programado"],
  [/\bas directed\b/gi, "según las indicaciones"],
  [/\bas scheduled\b/gi, "según lo programado"],
  [/\bas on your final medication list\b/gi, "como en su lista final de medicinas"],
  [/\bDo not take\b/g, "No tome"],
  [/\bTake\b/g, "Tome"],
  [/\bSee\b/g, "Vea a"],
  [/\bCall your doctor\b/gi, "Llame a su médico"],
  [/\bprimary care\b/gi, "médico de cabecera"],
  [/\bcardiology\b/gi, "cardiología"],
  [/\burology\b/gi, "urología"],
  [/\bpulmonology\b/gi, "neumología"],
  [/\bChest pain or pressure\b/gi, "Dolor o presión en el pecho"],
  [/\bchest pain\b/gi, "dolor en el pecho"],
  [/\bshortness of breath\b/gi, "falta de aire"],
  [/\bfever\b/gi, "fiebre"],
  [/\bswelling\b/gi, "hinchazón"],
  [/\bweight\b/gi, "peso"],
  [/\bhigh blood pressure\b/gi, "presión arterial alta"],
  [/\bheart failure\b/gi, "insuficiencia cardíaca"],
  [/\bA new medicine your care team started\.?/g, "Una medicina nueva que su equipo de atención empezó."],
  [/\bKeep taking this medicine as before\.?/g, "Siga tomando esta medicina como antes."],
  [/\bYour care team stopped or held this medicine\.?/g, "Su equipo de atención suspendió o pausó esta medicina."],
  [/\bCheck your recovery and your medicines\b/g, "Revisar su recuperación y sus medicinas"],
  [/\bTake your medicines exactly as listed and call your care team if you are not sure about anything\.?/g, "Tome sus medicinas exactamente como se indica y llame a su equipo de atención si tiene dudas."],
];

export function spanishPhrases(s: string): string {
  let out = s;
  for (const [re, rep] of ES) out = out.replace(re, rep);
  return out;
}

/** LLM_PROVIDER=bedrock | anthropic | offline, same switch as the simplifier. */
export async function createTranslator(config: Config, log: Logger): Promise<Translator> {
  switch (config.LLM_PROVIDER) {
    case "bedrock": {
      const { BedrockTranslator } = await import("./bedrock/translate.js");
      return new BedrockTranslator({ modelId: config.BEDROCK_MODEL_ID, region: config.AWS_REGION, log });
    }
    case "anthropic": {
      const { AnthropicTranslator } = await import("./anthropic/translate.js");
      return new AnthropicTranslator({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL, log });
    }
    case "offline":
    default:
      return new OfflineTranslator();
  }
}
