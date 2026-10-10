import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AiOutputSchema } from "../src/contracts/aiOutput.js";
import { OfflineTranslator } from "../src/pipeline/translate.js";
import { createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

/**
 * Task 5 of the backend tasks doc: GET /translation?lang=...&sum_id=...
 * 1. checks DynamoDB for an available translation on the summary id and returns it;
 * 2. otherwise reads the llm-summary (the GET /llm-sumary path), sends it to the translation agent
 *    with the language, waits, saves the response on the item, and returns it.
 */
describe("GET /translation?lang=&sum_id= (task 5)", () => {
  let t: TestApp;
  const translator = new OfflineTranslator();
  const spy = vi.spyOn(translator, "translate");
  let sumId: string;

  beforeAll(async () => {
    t = await createTestApp({ translator });
    ({ sumId } = await ingestText(t, exampleText("example-1-chf")));
    spy.mockClear();
  });
  afterAll(() => t.close());

  it("on a miss: sends the item's llm-summary to the translation agent, saves the result under translations[lang], returns it", async () => {
    const calls = spy.mock.calls.length;
    expect((await t.ctx.summaries.get(sumId))?.translations?.zh).toBeUndefined();
    const res = await request(t.app).get(`/translation?lang=zh&sum_id=${sumId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ "sum-id": sumId, sumId, lang: "zh", fromCache: false, daysLeft: 30 });
    expect(AiOutputSchema.parse(res.body.translation)).toEqual(res.body.translation);
    expect(res.body.translation.language).toBe("zh");
    expect(res.body.translation.medications[0]).toMatchObject({ name: "Furosemide", dose: "40 mg" });
    // The agent was given exactly the llm-summary that GET /llm-sumary serves.
    expect(spy.mock.calls.length).toBe(calls + 1);
    const llm = (await request(t.app).get(`/llm-sumary?sum-id=${sumId}`)).body["llm-summary"];
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ english: llm, language: "zh" });
    // Saved on the same DynamoDB item (here its SQL twin), in the translations map.
    expect((await t.ctx.summaries.get(sumId))?.translations?.zh).toEqual(res.body.translation);
    expect(res.body.availableLanguages).toEqual(["en", "zh"]);
  });

  it("on a hit: returns the stored translation without calling the agent, also by language name", async () => {
    const calls = spy.mock.calls.length;
    const first = (await t.ctx.summaries.get(sumId))?.translations?.zh;
    for (const lang of ["zh", "Mandarin", "zh-CN"]) {
      const res = await request(t.app).get(`/translation?lang=${lang}&sum_id=${sumId}`);
      expect(res.status, lang).toBe(200);
      expect(res.body.fromCache, lang).toBe(true);
      expect(res.body.translation, lang).toEqual(first);
    }
    expect(spy.mock.calls.length).toBe(calls);
  });

  it("lang=en returns the llm-summary itself", async () => {
    const calls = spy.mock.calls.length;
    const res = await request(t.app).get(`/translation?lang=en&sum_id=${sumId}`);
    expect(res.status).toBe(200);
    expect(res.body.translation).toEqual((await t.ctx.summaries.get(sumId))?.["llm-summary"]);
    expect(spy.mock.calls.length).toBe(calls);
  });

  it("answers 400 without lang, without sum_id or with an unknown language, and 404 for an id nobody issued", async () => {
    const calls = spy.mock.calls.length;
    const noLang = await request(t.app).get(`/translation?sum_id=${sumId}`);
    expect(noLang.status).toBe(400);
    expect(noLang.body).toMatchObject({ statusCode: 400, error: "missing_language" });
    const noId = await request(t.app).get("/translation?lang=es");
    expect(noId.status).toBe(400);
    expect(noId.body).toMatchObject({ statusCode: 400, error: "missing_sum_id" });
    const badLang = await request(t.app).get(`/translation?lang=klingon&sum_id=${sumId}`);
    expect(badLang.status).toBe(400);
    expect(badLang.body).toMatchObject({ statusCode: 400, error: "invalid_language" });
    const unknown = await request(t.app).get("/translation?lang=es&sum_id=AAAAAAAAAAAAAAAAAAAAAA");
    expect(unknown.status).toBe(404);
    expect(spy.mock.calls.length).toBe(calls);
  });

  it("does not cache a translation the check refuses (422), so the next request asks the agent again", async () => {
    spy.mockImplementationOnce(async (input) => {
      const out = structuredClone(input.english);
      out.medications[0].dose = "80 mg";
      return { output: { ...out, language: input.language }, provider: "test", model: "bad-dose" };
    });
    const bad = await request(t.app).get(`/translation?lang=ar&sum_id=${sumId}`);
    expect(bad.status).toBe(422);
    expect((await t.ctx.summaries.get(sumId))?.translations?.ar).toBeUndefined();
    const good = await request(t.app).get(`/translation?lang=ar&sum_id=${sumId}`);
    expect(good.status).toBe(200);
    expect(good.body.fromCache).toBe(false);
    expect((await t.ctx.summaries.get(sumId))?.translations?.ar).toEqual(good.body.translation);
  });
});
