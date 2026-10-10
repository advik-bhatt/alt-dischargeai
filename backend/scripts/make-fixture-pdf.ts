/**
 * Renders fixtures/discharge-summaries/example-1-chf.txt into example-1-chf.pdf for the PDF ingest
 * test. Run once: `npm run make-fixture-pdf`. Uses pdfkit (MIT), a dev dependency only.
 */
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import PDFDocument from "pdfkit";

const dir = join(import.meta.dirname, "..", "fixtures", "discharge-summaries");
const name = process.argv[2] ?? "example-1-chf";
const text = readFileSync(join(dir, `${name}.txt`), "utf8");
const out = join(dir, `${name}.pdf`);

const doc = new PDFDocument({ size: "LETTER", margin: 54, info: { Title: `DischargeAI fixture ${name}` } });
doc.pipe(createWriteStream(out));
doc.font("Helvetica").fontSize(11);
for (const line of text.split("\n")) {
  doc.text(line.length ? line : " ", { lineGap: 2 });
}
doc.end();
console.log(`wrote ${out}`);
