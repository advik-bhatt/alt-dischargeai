import { normalizeText } from "./text.js";

export interface PdfText {
  text: string;
  pages: number;
  engine: "pdf-parse" | "pdfjs-dist";
}

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

export function looksLikePdf(buf: Buffer): boolean {
  return buf.length > PDF_MAGIC.length && buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/** pdf-parse v2 (`PDFParse` class) first, pdfjs-dist legacy build as the fallback. Both verified on the handout PDF. */
export async function extractPdfText(buf: Buffer): Promise<PdfText> {
  if (!looksLikePdf(buf)) throw new Error("not a PDF (missing %PDF- header)");
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buf });
    try {
      const r = await parser.getText();
      const text = normalizeText(r.text ?? "");
      if (text.length > 0) return { text, pages: r.total ?? 0, engine: "pdf-parse" };
    } finally {
      await parser.destroy();
    }
  } catch {
    /* fall through to pdfjs */
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useWorkerFetch: false }).promise;
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    parts.push(content.items.map((i) => ("str" in i ? i.str : "")).join(" "));
  }
  const text = normalizeText(parts.join("\n\n"));
  if (!text) throw new Error("PDF contained no extractable text");
  return { text, pages: doc.numPages, engine: "pdfjs-dist" };
}
