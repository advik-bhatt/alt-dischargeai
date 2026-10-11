import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { startLocalServer } from "../scripts/local-server.js";
import type { ChatProvider, ChatTurn } from "../src/pipeline/chat.js";
import { planMarkdown } from "../src/routes/chat.js";

const headers = { "Content-Type": "application/json", "x-provider-key": "local-test-key" };
const post = (body: unknown, h: Record<string, string> = { "Content-Type": "application/json" }): RequestInit => ({ method: "POST", headers: h, body: JSON.stringify(body) });

test("the plan text comes from summary, result or a bare string", () => {
  assert.equal(planMarkdown({ summary: "# Plan", result: "other" }), "# Plan");
  assert.equal(planMarkdown({ result: "# Hackathon plan" }), "# Hackathon plan");
  assert.equal(planMarkdown("# Text"), "# Text");
  assert.equal(planMarkdown({ status: "approved" }), undefined);
  assert.equal(planMarkdown(null), undefined);
});

test("patient chat answers from the stored plan, passes the conversation, and stops at expiry", async () => {
  const seen: { plan: string; question: string; history: ChatTurn[] }[] = [];
  const chat: ChatProvider = { name: "test-chat", async ask(plan, question, history) {
    seen.push({ plan, question, history });
    return { text: "Your plan says: take it once a day.", route: "plan_answer", quotes: ["take it once a day"] };
  } };
  const h = await startLocalServer(0, { chat });
  try {
    const accepted = await (await fetch(h.origin + "/api/ingest", post({ patientID: "7", DOB: "2000-01-01", type: "text", data: "Synthetic chat notes" }, headers))).json();
    await h.ctx.queue.onIdle();
    const url = h.origin + "/api/chat";
    const ok = await fetch(url, post({ token: accepted.sumId, question: "When do I take it?", history: [["Hi", "Hello"]] }));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { text: "Your plan says: take it once a day.", route: "plan_answer", quotes: ["take it once a day"] });
    assert.match(seen[0].plan, /Synthetic chat notes/);
    assert.deepEqual(seen[0].history, [["Hi", "Hello"]]);
    const audit = await h.ctx.audit.listByEvent("chat.answered");
    assert.equal(audit.length, 1); assert.deepEqual(audit[0].details, { route: "plan_answer" });
    assert.ok(!JSON.stringify(audit).includes("When do I take it?"), "the question text is never stored");

    assert.equal((await fetch(url, post({ token: accepted.sumId, question: " " }))).status, 400);
    assert.equal((await fetch(url, post({ token: accepted.sumId, question: "q", history: Array(7).fill(["a", "b"]) }))).status, 400);
    assert.equal((await fetch(url, post({ token: "A".repeat(43), question: "q" }))).status, 404);
    h.ctx.clock.advanceDays(31);
    assert.equal((await fetch(url, post({ token: accepted.sumId, question: "Still there?" }))).status, 410);
    assert.equal(seen.length, 1);
  } finally { await h.close(); }
});

// The real AI-Infra bridge, on the path that answers without a model call (needs AI-Infra's Python deps).
const python = process.env.PYTHON_EXECUTABLE ?? "python3";
const bridgeReady = spawnSync(python, ["-c", "import boto3, langgraph"], { cwd: resolve(import.meta.dirname, "../../AI-Infra") }).status === 0;
test("the AI-Infra chat bridge sends an emergency to 911 with the plan's own warning lines", { skip: !bridgeReady && "AI-Infra Python dependencies are not installed" }, () => {
  const plan = "# Your Going-Home Plan\n\n## Get help RIGHT AWAY — call 911 if:\n- You have chest pain\n";
  const run = spawnSync(python, ["-m", "patient_agents.chat_bridge"], {
    cwd: resolve(import.meta.dirname, "../../AI-Infra"), input: JSON.stringify({ plan, question: "I have chest pain right now", history: [] }),
    env: { ...process.env, DISCHARGEAI_AWS_PROFILE: "", AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "unused", AWS_SECRET_ACCESS_KEY: "unused" }, encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const reply = JSON.parse(run.stdout);
  assert.equal(reply.route, "emergency");
  assert.match(reply.text, /call 911/);
  assert.deepEqual(reply.quotes, ["You have chest pain"]);
});
