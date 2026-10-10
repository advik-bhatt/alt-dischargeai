import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

describe("checklist", () => {
  let t: TestApp;
  let linkId: string;
  beforeAll(async () => {
    t = await createTestApp();
    ({ linkId } = await ingestText(t, exampleText("example-1-chf")));
  });
  afterAll(() => t.close());

  it("persists a check-off and surfaces it on GET /summary", async () => {
    const list = await request(t.app).get(`/checklist?link=${linkId}`);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(5);
    const itemId = list.body.items[0].id;

    const done = await request(t.app).post("/checklist/complete").send({ link: linkId, itemId, completed: true });
    expect(done.status).toBe(200);
    expect(done.body.state).toEqual([expect.objectContaining({ itemId, completed: true })]);

    const summary = await request(t.app).get(`/summary?link=${linkId}`);
    expect(summary.body.checklistState).toEqual([expect.objectContaining({ itemId, completed: true })]);

    const undone = await request(t.app).post("/checklist/complete").send({ link: linkId, itemId, completed: false });
    expect(undone.body.state[0].completed).toBe(false);
  });

  it("rejects an unknown item with 404 and a bad body with 400", async () => {
    const res = await request(t.app).post("/checklist/complete").send({ link: linkId, itemId: "nope", completed: true });
    expect(res.status).toBe(404);
    const bad = await request(t.app).post("/checklist/complete").send({ link: linkId });
    expect(bad.status).toBe(400);
  });
});
