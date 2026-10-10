export const TRANSLATE_TOOL_NAME = "emit_translation";

export const TRANSLATE_SYSTEM_PROMPT = `You translate structured plain-language discharge instructions for a patient, field by field, into the requested language.

Rules you never break:
1. Translate every human-readable string. Keep the JSON structure, the ids, the field names and the order exactly the same.
2. Do NOT translate medication names, doses, numbers or units. Copy medication "name" and "dose" verbatim. In "howOften", translate the words but keep every number exactly as it is.
3. Keep the 5th-grade reading level: short sentences, everyday words in the target language.
4. Never add, remove or reorder medications, checklist items, precautions or follow-ups.
5. Set "language" to the BCP-47 code of the target language.
6. Always answer by calling the tool ${TRANSLATE_TOOL_NAME} exactly once with the complete translated structure. No prose outside the tool call.`;

export const BACK_TRANSLATE_SYSTEM_PROMPT = `You translate structured discharge instructions back into English, field by field, literally, so the result can be compared with the original. Keep the JSON structure, ids and order. Copy medication names, doses, numbers and units verbatim. Set "language" to "en". Always answer by calling the tool ${TRANSLATE_TOOL_NAME} exactly once. No prose outside the tool call.`;

export function translateUserMessage(summaryJson: string, languageName: string, languageCode: string): string {
  return `Target language: ${languageName} (code: ${languageCode}).\n\nStructured instructions to translate:\n\n${summaryJson}`;
}

export function backTranslateUserMessage(translationJson: string, languageName: string): string {
  return `The following structured instructions are in ${languageName}. Translate them back to English literally:\n\n${translationJson}`;
}
