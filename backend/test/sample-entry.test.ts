import { describe, expect, it } from "vitest";
import { AiOutputSchema } from "../src/contracts/aiOutput.js";
import { isSumIdShaped } from "../src/crypto/sumId.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { LocalSummaryStore } from "../src/docstore/local.js";
import { applySample, buildSampleItem, SAMPLE_ID } from "../scripts/sample-entry.js";

async function store() {
  const db = await openDb(loadConfig({ DATABASE_FILE: ":memory:" }));
  await migrate(db);
  return new LocalSummaryStore(db);
}

describe("npm run sample-entry: the hand-written sample in the DynamoDB table", () => {
  const now = new Date("2026-10-11T00:00:00.000Z");

  it("builds a valid item in the team's layout: a readable 22-character id, the contract JSON, one stored translation, 30 days to live, marked as the sample", () => {
    const item = buildSampleItem(now);
    expect(isSumIdShaped(SAMPLE_ID)).toBe(true);
    expect(item).toMatchObject({ uid: SAMPLE_ID, "sum-id": SAMPLE_ID, patientID: "sample-patient", status: "ready", inputKind: "text", meta: { sample: true } });
    expect(AiOutputSchema.safeParse(item["llm-summary"]).success).toBe(true);
    expect(Object.keys(item.translations ?? {})).toEqual(["es"]);
    expect(AiOutputSchema.safeParse(item.translations!.es).success).toBe(true);
    expect(item.expiresAt).toBe(Math.floor(now.getTime() / 1000) + 30 * 86400);
    expect(item["raw-text"]).toContain("Furosemide 40 mg");
  });

  it("writes it, leaves an existing sample alone, resets it to the original state, and deletes it", async () => {
    const s = await store();
    expect((await applySample(s, "delete", now)).action).toBe("nothing to delete");
    expect((await applySample(s, "write", now)).action).toBe("written");
    await s.setTranslation(SAMPLE_ID, "zh", buildSampleItem(now)["llm-summary"]!);
    const again = await applySample(s, "write", now);
    expect(again.action).toBe("already there");
    expect(Object.keys((await s.get(SAMPLE_ID))!.translations ?? {})).toEqual(["es", "zh"]);
    expect((await applySample(s, "reset", now)).action).toBe("reset");
    expect(Object.keys((await s.get(SAMPLE_ID))!.translations ?? {})).toEqual(["es"]);
    expect((await applySample(s, "delete", now)).action).toBe("deleted");
    expect(await s.get(SAMPLE_ID)).toBeNull();
  });

  it("never touches an item with that id that is not the sample, in any mode", async () => {
    const s = await store();
    const real = { ...buildSampleItem(now), meta: { provider: "a real ingest" }, "raw-text": "real patient text" };
    await s.put(real);
    for (const mode of ["write", "reset", "delete"] as const) {
      expect((await applySample(s, mode, now)).action).toBe("refused");
      expect(await s.get(SAMPLE_ID)).toMatchObject({ "raw-text": "real patient text", meta: { provider: "a real ingest" } });
    }
  });
});
