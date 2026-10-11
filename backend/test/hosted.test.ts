import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.js";
import { applyHostedAwsCredentials, createHostedContext } from "../src/hosted/context.js";
import { toPostgres } from "../src/hosted/postgres.js";
import type { AgentProvider } from "../src/pipeline/agent.js";

test("repository SQL is rewritten for Postgres without touching string literals", () => {
  assert.equal(toPostgres("SELECT * FROM activeLinks WHERE sumId = ? AND status <> 'purged' ORDER BY expiresAt LIMIT ?"),
    `SELECT * FROM "activeLinks" WHERE "sumId" = $1 AND status <> 'purged' ORDER BY "expiresAt" LIMIT $2`);
  assert.equal(toPostgres("SELECT * FROM `patientinfo` WHERE `ID` = ? LIMIT 1"), `SELECT * FROM "patientinfo" WHERE "ID" = $1 LIMIT 1`);
  assert.equal(toPostgres("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?"),
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = current_schema() AND TABLE_NAME = $1");
  assert.equal(toPostgres(`SELECT uid, (item->>'expiresAt')::bigint AS "expiresAt" FROM t WHERE x <= ?`),
    `SELECT uid, (item->>'expiresAt')::bigint AS "expiresAt" FROM t WHERE x <= $1`);
});

// Needs a disposable Postgres, e.g. docker run -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
// and HOSTED_TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:54329/postgres?sslmode=disable
const url = process.env.HOSTED_TEST_POSTGRES_URL;

test("hosted mode signs in, ingests, serves the plan and keeps it across a restart", { skip: !url && "set HOSTED_TEST_POSTGRES_URL", timeout: 60_000 }, async () => {
  const env = { POSTGRES_URL: url, PROVIDER_API_KEY: "hosted-test-provider-key-0123456789", DOCTOR_EMAIL: "Doctor@Example.test", DOCTOR_PASSWORD: "correct horse",
    PATIENT_APP_URL: "https://dischargeai.example.test", LOG_LEVEL: "silent", PURGE_INTERVAL_MS: "0", PORT: "0" };
  const calls: string[] = [];
  const agent: AgentProvider = { name: "test-agent", runtimeArn: "test", async invoke(notes, sessionId) {
    calls.push(notes);
    return { response: { status: "approved", flags: [], summary: `Plan for: ${notes}`, plan: null }, sessionId, latencyMs: 1 };
  } };
  const start = async () => {
    const ctx = await createHostedContext(env, { agent });
    const server = buildApp(ctx).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { ctx, origin, close: async () => { server.close(); await ctx.close(); } };
  };
  const json = (body: unknown, key?: string): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "x-provider-key": key } : {}) }, body: JSON.stringify(body) });

  let h = await start();
  let sumId: string;
  try {
    assert.equal((await fetch(h.origin + "/api/auth/login", json({ email: "doctor@example.test", password: "wrong" }))).status, 401);
    const login = await (await fetch(h.origin + "/api/auth/login", json({ email: "doctor@example.test", password: "correct horse" }))).json();
    assert.equal(login.providerKey, env.PROVIDER_API_KEY);
    const key = login.providerKey as string;

    const patients = (await (await fetch(h.origin + "/api/patients", { headers: { "x-provider-key": key } })).json()).patients;
    assert.ok(patients.some((p: { ID: string }) => String(p.ID) === "7"));
    const id = `hosted-${Date.now()}`;
    assert.equal((await fetch(h.origin + "/api/patients", json({ ID: id, DOB: "1990-05-06", FirstName: "Synthetic" }, key))).status, 201);
    assert.equal((await fetch(h.origin + "/api/patients", json({ ID: id, DOB: "1991-05-06" }, key))).status, 409);

    const accepted = await (await fetch(h.origin + "/api/ingest", json({ patientID: id, DOB: "1990-05-06", type: "text", data: "Synthetic hosted notes" }, key))).json();
    assert.match(accepted.link, /^https:\/\/dischargeai\.example\.test\/s\//);
    sumId = accepted.sumId;
    await h.ctx.queue.onIdle();
    const job = await (await fetch(`${h.origin}/api/jobs/${accepted.jobId}`, { headers: { "x-provider-key": key } })).json();
    assert.equal(job.stage, "done");
    assert.deepEqual(calls, ["Synthetic hosted notes"]);
    const access = await fetch(h.origin + "/api/auth/link", json({ token: sumId, dob: "1990-05-06", role: "patient" }));
    assert.equal(access.status, 200);
  } finally { await h.close(); }

  // A new instance on the same database still serves the plan.
  h = await start();
  try {
    const summary = await (await fetch(`${h.origin}/api/llm-summary?sum-id=${sumId!}`)).json();
    assert.equal(summary["llm-summary"].summary, "Plan for: Synthetic hosted notes");
    assert.equal((await fetch(h.origin + "/api/auth/link", json({ token: sumId!, dob: "1990-05-07", role: "patient" }))).status, 401);
    // Check-ins are stored on the Postgres summary item and reach the follow-up board.
    const checkin = await fetch(h.origin + "/api/checkin", json({ token: sumId!, meds: "none", weightLb: 170 }));
    assert.equal(checkin.status, 201);
    const board = await (await fetch(h.origin + "/api/followups", { headers: { "x-provider-key": env.PROVIDER_API_KEY } })).json();
    const row = board.followups.find((f: { sumId: string }) => f.sumId === sumId);
    assert.equal(row.level, "attention"); assert.equal(row.lastWeightLb, 170);
    assert.equal(((await h.ctx.summaries.get(sumId!))?.checkins ?? []).length, 1);
  } finally { await h.close(); }
});

test("hosted mode refuses to start with the public development provider key", { skip: !url && "set HOSTED_TEST_POSTGRES_URL" }, async () => {
  await assert.rejects(createHostedContext({ POSTGRES_URL: url, LOG_LEVEL: "silent" }), /PROVIDER_API_KEY/);
});

test("hosted AWS credentials under DISCHARGEAI_AWS_* replace the standard names", () => {
  const env: Record<string, string | undefined> = { DISCHARGEAI_AWS_ACCESS_KEY_ID: "id", DISCHARGEAI_AWS_SECRET_ACCESS_KEY: "secret", DISCHARGEAI_AWS_SESSION_TOKEN: "token", AWS_ACCESS_KEY_ID: "platform" };
  assert.equal(applyHostedAwsCredentials(env), "DISCHARGEAI_AWS_*");
  assert.deepEqual([env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN], ["id", "secret", "token"]);
  const permanent: Record<string, string | undefined> = { DISCHARGEAI_AWS_ACCESS_KEY_ID: "id", DISCHARGEAI_AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "stale" };
  applyHostedAwsCredentials(permanent);
  assert.equal(permanent.AWS_SESSION_TOKEN, undefined);
  assert.equal(applyHostedAwsCredentials({}), "none");
});

test("hosted /health hides the diagnostics from anonymous callers and shows them with the provider key", async () => {
  const express = (await import("express")).default;
  const { healthRouter } = await import("../src/routes/health.js");
  const key = "hosted-test-provider-key-0123456789";
  const ctx = {
    mode: "hosted", config: { PROVIDER_API_KEY: key }, linkTtlDays: 30,
    agent: { name: "agentcore", runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/Example" },
    liveDictation: { name: "transcribe-medical-streaming" }, translator: {}, readAloud: undefined, chat: {},
    clock: { nowIso: () => "2026-10-11T00:00:00.000Z", offsetDays: 0, demoNow: null },
    secrets: { source: "env", applied: [], overriddenByEnv: [], missingKeys: [] },
    speechToText: { name: "unavailable" }, db: { describe: "postgres://dischargeai_app.ref@pooler.example:5432/postgres" },
    summaries: { name: "postgres", describe: "postgres hosted_summaries" }, pdf: { describe: () => "pdf" }, audio: { describe: () => "audio" },
    receipts: { name: "sql" }, mailer: { transportName: "console" }, queue: { size: 0 },
  } as unknown as import("../src/context.js").AppContext;
  const server = express().use(healthRouter(ctx)).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const anonymous = await (await fetch(origin + "/health")).text();
    assert.deepEqual(Object.keys(JSON.parse(anonymous)).sort(), ["capabilities", "linkTtlDays", "mode", "ok", "service"]);
    assert.doesNotMatch(anonymous, /123456789012|dischargeai_app|pooler/);
    assert.equal(JSON.parse(await (await fetch(origin + "/health", { headers: { "x-provider-key": "wrong" } })).text()).providers, undefined);
    const full = await (await fetch(origin + "/health", { headers: { "x-provider-key": key } })).json();
    assert.equal(full.providers.agentRuntimeArn, "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/Example");
  } finally { server.close(); }
});
