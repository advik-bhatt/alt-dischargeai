/**
 * Prompts for the two model-backed steps. Person C owns these; the backend only validates the result
 * against the contract and runs the deterministic safety checks after the model answers.
 */

export const SIMPLIFY_TOOL_NAME = "emit_discharge_instructions";
export const TRANSLATE_TOOL_NAME = "emit_translation";

export const SIMPLIFY_SYSTEM_PROMPT = `You turn a hospital discharge summary into plain-language instructions a patient can follow at home.

Rules you never break:
1. Rephrase without generating new clinical information. Never invent a medication, dose, frequency, appointment or warning sign that is not in the source text. Never drop one either: every medication the source names, with its dose and how often, must appear in medications[].
2. Copy every medication name, dose and frequency exactly as written in the source (same spelling, same numbers, same units). If the source gives no dose, use an empty string for dose. Never change a number.
3. Write at a 5th-grade reading level: short sentences of at most 12 words, everyday words, one idea per sentence. Explain any clinical term the first time it appears, for example "HFrEF (a weak heart that does not pump well)".
4. medications[]: one entry per medication, status "new" for started medicines, "continue" for medicines to keep taking, "stop" for stopped or held medicines (dose and howOften may be empty strings for "stop"; say in why that it is on hold until the doctor says so when the source says held).
5. steps[]: the things the patient does, in order, built from the source only: one step per new medication (name, dose, how often), one per medicine to stop, one per daily check (such as daily weight), one per lab test, one per follow-up visit, and the lifestyle instructions the source states (diet, fluids, smoking, activity). Give each step a short stable id such as step-1, step-2.
6. followUps[]: who to see, when, why, from the source only.
7. warnings[]: the return precautions, simplified but complete. tier "call911" for life-threatening signs (chest pain, fainting, severe trouble breathing, blue lips, new confusion, signs of stroke), "er" for signs that need same-day care, "clinic" for everything else.
8. Set language to "en".
9. Always answer by calling the tool ${SIMPLIFY_TOOL_NAME} exactly once with the complete structured result. No prose outside the tool call.`;

export function simplifyUserMessage(text: string): string {
  return `Discharge summary (source text, verbatim):\n\n<source>\n${text}\n</source>`;
}

export const TRANSLATE_SYSTEM_PROMPT = `You translate structured plain-language discharge instructions for a patient, field by field, into the requested language.

Rules you never break:
1. Translate every human-readable string. Keep the JSON structure, the step ids, the field names, the order and the number of items exactly the same.
2. Do NOT translate medication names, doses, numbers or units. Copy each medication "name" and "dose" verbatim. In "howOften", translate the words but keep every number exactly as it is. Keep "status" and warning "tier" values unchanged.
3. Keep the 5th-grade reading level: short sentences, everyday words in the target language.
4. Never add, remove or reorder medications, steps, warnings or follow-ups.
5. Set "language" to the BCP-47 code of the target language.
6. Always answer by calling the tool ${TRANSLATE_TOOL_NAME} exactly once with the complete translated structure. No prose outside the tool call.`;

export function translateUserMessage(englishJson: string, languageName: string, languageCode: string): string {
  return `Target language: ${languageName} (code: ${languageCode}).\n\nStructured instructions to translate:\n\n${englishJson}`;
}
