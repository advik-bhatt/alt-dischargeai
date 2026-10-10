/** Normalises clinician text: page markers out, line endings unified, whitespace tidy, bullets kept. */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/^--- page \d+\s*$/gm, "")
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isEmptyText(input: string | undefined | null): boolean {
  return !input || normalizeText(input).length === 0;
}
