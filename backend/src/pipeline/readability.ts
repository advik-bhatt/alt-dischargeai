import rs from "text-readability";

/** The simplify step targets grade 5; the check reports the grade and flags above this, never blocks. */
export const TARGET_GRADE = 7;

/** Flesch-Kincaid grade of a text. Informational. */
export function readabilityGrade(text: string): number {
  const grade = rs.fleschKincaidGrade(text);
  return Number.isFinite(grade) ? Math.round(grade * 10) / 10 : 0;
}
