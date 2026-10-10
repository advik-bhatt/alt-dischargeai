import rs from "text-readability";
import type { Warning } from "../agents/types.js";

export const TARGET_GRADE = 7;

/** Flesch-Kincaid grade of the summary paragraph. Informational: reported above grade 7, never blocks. */
export function readabilityGrade(text: string): number {
  const grade = rs.fleschKincaidGrade(text);
  return Number.isFinite(grade) ? Math.round(grade * 10) / 10 : 0;
}

export function readabilityWarning(text: string): { grade: number; warning?: Warning } {
  const grade = readabilityGrade(text);
  if (grade > TARGET_GRADE) {
    return {
      grade,
      warning: {
        code: "readability_above_target",
        message: `Summary reads at grade ${grade}; target is grade 5 (threshold ${TARGET_GRADE})`,
        field: "summary",
        value: grade,
      },
    };
  }
  return { grade };
}
