import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AiOutputSchema } from "../src/contracts/aiOutput.js";
import { OfflineTranslator } from "../src/pipeline/translate.js";
import { VIEW_KEYS, createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

describe("GET /translate: cache-first in the document store, translation agent on a miss", () => {
  let t: TestApp;
  const translator = new OfflineTranslator();
  const spy = vi.spyOn(translator, "translate");
  let linkId: string;

  beforeAll(async () => {
    t = await createTestApp({ translator });
    ({ linkId } = await ingestText(t, exampleText("example-1-chf")));
    spy.mockClear();
  });
  afterAll(() => t.close());

  it("requires a language and rejects one it cannot resolve", async () => {
    const missing = await request(t.app).get(`/translate?link=${linkId}`);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("missing_language");
    const bad = await request(t.app).get(`/translate?link=${linkId}&language=klingon`);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_language");
  });

  it("calls the agent on the first request, serves the document store on the second", async () => {
    const first = await request(t.app).get(`/translate?link=${linkId}&language=Spanish`);
    expect(first.status).toBe(200);
    expect(first.body.fromCache).toBe(false);
    expect(first.body.language).toBe("es");
    expect(Object.keys(first.body).sort()).toEqual([...VIEW_KEYS].sort());
    expect(first.body.steps[0].text).toMatch(/^Tome Furosemide 40 mg/);
    expect(first.body.medications[0]).toMatchObject({ name: "Furosemide", dose: "40 mg" });
    expect(first.body.availableLanguages).toEqual(["en", "es"]);
    expect(spy).toHaveBeenCalledTimes(1);

    const second = await request(t.app).get(`/translate?link=${linkId}&language=es`);
    expect(second.status).toBe(200);
    expect(second.body.fromCache).toBe(true);
    expect(second.body.steps).toEqual(first.body.steps);
    expect(spy).toHaveBeenCalledTimes(1);

    const regional = await request(t.app).get(`/translate?link=${linkId}&language=es-MX`);
    expect(regional.body.fromCache).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("serves Mandarin and Arabic offline with names and doses verbatim, each validating against the contract", async () => {
    for (const lang of ["zh", "ar"]) {
      const res = await request(t.app).get(`/translate?link=${linkId}&language=${lang}`);
      expect(res.status, lang).toBe(200);
      expect(res.body.language).toBe(lang);
      const { expiresAt: _e, daysLeft: _d, availableLanguages: _a, fromCache: _f, ...output } = res.body;
      expect(AiOutputSchema.safeParse(output).success).toBe(true);
      expect(res.body.medications.map((m: { name: string; dose: string }) => `${m.name}|${m.dose}`).slice(0, 4)).toEqual([
        "Furosemide|40 mg",
        "Losartan|25 mg",
        "Empagliflozin|10 mg",
        "Amoxicillin-clavulanate|875/125 mg",
      ]);
    }
    const en = await request(t.app).get(`/summary?link=${linkId}`);
    expect(en.body.availableLanguages).toEqual(["en", "es", "zh", "ar"]);
  });

  it("refuses a translation that changes a dose (422) and does not cache it", async () => {
    const tampering = new OfflineTranslator();
    vi.spyOn(tampering, "translate").mockImplementation(async (input) => {
      const r = await translator.translate(input);
      r.output.medications[0].dose = "400 mg";
      return r;
    });
    const bad = await createTestApp({ translator: tampering });
    try {
      const { linkId: l2 } = await ingestText(bad, exampleText("example-1-chf"));
      const res = await request(bad.app).get(`/translate?link=${l2}&language=fr`);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("translation_rejected");
      expect(res.body.issues).toContain("medication_dose_changed:0");
      const en = await request(bad.app).get(`/summary?link=${l2}`);
      expect(en.body.availableLanguages).toEqual(["en"]);
    } finally {
      await bad.close();
    }
  });
});
