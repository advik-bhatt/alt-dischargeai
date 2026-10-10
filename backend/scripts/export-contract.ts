/**
 * Writes contracts/ai-output.schema.json from the zod contract in src/contracts/aiOutput.ts.
 *   npm run export-contract
 * test/contract.test.ts fails when the committed file drifts from the zod source.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishedAiOutputSchema } from "../src/contracts/aiOutput.js";

const file = join(import.meta.dirname, "..", "contracts", "ai-output.schema.json");
writeFileSync(file, JSON.stringify(publishedAiOutputSchema(), null, 2) + "\n");
console.log(`wrote ${file}`);
