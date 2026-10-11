import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import type { TranscribeClient } from "@aws-sdk/client-transcribe";
import { startLocalServer } from "../scripts/local-server.js";
import { LOCAL_AUDIO_TRANSCRIPT } from "../scripts/local/context.js";
import { ElevenLabsReadAloud } from "../src/pipeline/readAloud.js";
import { HealthScribeSpeechToText } from "../src/pipeline/transcribe/healthscribe.js";
import { adaptSummary } from "../../frontend/src/planAdapter.js";
import { speechTextFor } from "../../frontend/src/speechText.js";

const headers = { "Content-Type": "application/json", "x-provider-key": "local-test-key" };
const post = (body: unknown): RequestInit => ({ method: "POST", headers, body: JSON.stringify(body) });
const ingest = (data: string, DOB = "2000-01-01") => post({ patientID: "7", DOB, type: "text", data });

test("registration validates dates, matches identities and refuses a different DOB", async () => {
  const h = await startLocalServer(0);
  try {
    const url = h.origin + "/api/patients";
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    for (const DOB of ["2000-02-30", "2999-01-01", "01/01/2000"]) assert.equal((await fetch(url, post({ ID: "new", DOB }))).status, 400);
    const created = await fetch(url, post({ ID: "new", DOB: "2000-01-01", FirstName: "Synthetic", email: "test@example.test" }));
    assert.equal(created.status, 201); assert.equal((await created.json()).created, true);
    const matched = await fetch(url, post({ ID: "new", DOB: "2000-01-01" }));
    assert.equal(matched.status, 200); assert.equal((await matched.json()).patient.FirstName, "Synthetic");
    assert.equal((await fetch(url, post({ ID: "new", DOB: "2001-01-01" }))).status, 409);
    assert.equal((await h.ctx.patients.getById("new"))?.dateOfBirth, "2000-01-01");
    const parallel = await Promise.all([fetch(url, post({ ID: "race", DOB: "2000-01-01" })), fetch(url, post({ ID: "race", DOB: "2000-01-01" }))]);
    assert.deepEqual(parallel.map(r => r.status).sort(), [200, 201]);
  } finally { await h.close(); }
});

test("updates preserve the original link and expiry, reject busy/DOB mismatch, and start fresh after expiry", async () => {
  const h = await startLocalServer(0);
  try {
    const url = h.origin + "/api/ingest";
    const first = await (await fetch(url, ingest("Original synthetic notes"))).json();
    assert.equal((await fetch(url, ingest("Conflicting update"))).status, 409);
    await h.ctx.queue.onIdle();
    assert.equal((await fetch(url, ingest("Wrong identity", "2001-01-01"))).status, 409);
    h.ctx.clock.advanceDays(29);
    const updated = await (await fetch(url, ingest("Follow-up synthetic notes"))).json();
    assert.equal(updated.appended, true); assert.equal(updated.sumId, first.sumId); assert.equal(updated.expiresAt, first.expiresAt);
    await h.ctx.queue.onIdle();
    const item = (await h.ctx.summaries.get(first.sumId))!;
    assert.match(item["raw-text"]!, /Original synthetic notes[\s\S]*Follow-up synthetic notes/);
    h.ctx.clock.advanceDays(2);
    const next = await (await fetch(url, ingest("New visit after expiry"))).json();
    assert.notEqual(next.sumId, first.sumId); await h.ctx.queue.onIdle();
    assert.equal((await fetch(h.origin + "/api/p/" + first.sumId)).status, 410);
    assert.equal((await h.ctx.summaries.get(next.sumId))?.["raw-text"], "New visit after expiry");
  } finally { await h.close(); }
});

test("recorded audio appends its recognized transcript to prior notes and remains purgeable", async () => {
  const h = await startLocalServer(0);
  try {
    const first = await (await fetch(h.origin + "/api/ingest", ingest("Prior visit"))).json(); await h.ctx.queue.onIdle();
    const form = new FormData(); form.set("patientId", "7"); form.set("DOB", "2000-01-01"); form.set("audio", new Blob(["test audio"], { type: "audio/webm" }), "dictation.webm");
    const response = await fetch(h.origin + "/api/ingest", { method: "POST", headers: { "x-provider-key": "local-test-key" }, body: form });
    assert.equal(response.status, 202); assert.equal((await response.json()).sumId, first.sumId); await h.ctx.queue.onIdle();
    const item = (await h.ctx.summaries.get(first.sumId))!;
    assert.ok(item["raw-text"]!.includes("Prior visit")); assert.ok(item["raw-text"]!.includes(LOCAL_AUDIO_TRANSCRIPT));
    assert.ok(await h.ctx.audio.get(item.audioKey!)); h.ctx.clock.advanceDays(31); await h.ctx.purge();
    assert.equal(await h.ctx.audio.get(item.audioKey!), null);
  } finally { await h.close(); }
});

test("translation caches per revision, keeps checklist IDs, and read-aloud only accepts displayed sections", async () => {
  let translations = 0; const spoken: { text: string; language: string }[] = [];
  const h = await startLocalServer(0, { translator: { name: "test-translator", async translate(plan, lang) {
    translations++; const translated = structuredClone(plan); translated.title = `Synthetic ${lang}`;
    return { plan: translated, status: "verified", problems: [] };
  } }, readAloud: { name: "test-speech", async synthesize(text, language) { spoken.push({ text, language }); return Buffer.from("test-mp3"); } } });
  try {
    const accepted = await (await fetch(h.origin + "/api/ingest", ingest("Synthetic source"))).json(); await h.ctx.queue.onIdle();
    const english = await (await fetch(h.origin + "/api/p/" + accepted.sumId)).json(); const plan = adaptSummary(english).record.byLang.en!;
    const translateUrl = `${h.origin}/api/translation?sum_id=${accepted.sumId}&lang=es`;
    const [a, b] = await Promise.all([fetch(translateUrl), fetch(translateUrl)]); assert.equal(a.status, 200); assert.equal(b.status, 200);
    const result = await a.json(); await fetch(translateUrl); assert.equal(translations, 1);
    assert.deepEqual(result.translatedPlan.medications.groups[0].items.map((i: { id: string }) => i.id), plan.medications.groups[0].items.map(i => i.id));
    assert.equal((await fetch(`${h.origin}/api/translate?sum_id=${accepted.sumId}&lang=fr`)).status, 400);
    const speak = (text: string, language = "es") => fetch(h.origin + "/api/read-aloud", post({ token: accepted.sumId, language, text }));
    assert.equal((await speak("Arbitrary text unrelated to this patient")).status, 400);
    assert.equal((await speak("Unknown language content", "zh")).status, 409);
    const text = speechTextFor(result.translatedPlan, "es").medsText;
    const audio = await speak(text); assert.equal(audio.status, 200); assert.equal(audio.headers.get("content-type"), "audio/mpeg");
    assert.equal(audio.headers.get("cache-control"), "no-store"); assert.equal(await audio.text(), "test-mp3"); assert.deepEqual(spoken, [{ text, language: "es" }]);
    await Promise.all(["zh", "ar"].map(lang => fetch(`${h.origin}/api/translation?sum_id=${accepted.sumId}&lang=${lang}`)));
    assert.deepEqual(Object.keys((await h.ctx.summaries.get(accepted.sumId))!.translations!).sort(), ["ar", "es", "zh"]);
    await fetch(h.origin + "/api/ingest", ingest("Follow-up")); await h.ctx.queue.onIdle(); await fetch(translateUrl); assert.equal(translations, 4);
    h.ctx.clock.advanceDays(31); assert.equal((await speak(text)).status, 410); assert.equal((await fetch(translateUrl)).status, 410);
  } finally { await h.close(); }
});

test("provider failures return errors without synthetic translations or speech", async () => {
  const h = await startLocalServer(0, { translator: { name: "failure", async translate() { throw new Error("translation unavailable"); } },
    readAloud: { name: "failure", async synthesize() { throw new Error("speech unavailable"); } } });
  try {
    const accepted = await (await fetch(h.origin + "/api/ingest", ingest("Synthetic source"))).json(); await h.ctx.queue.onIdle();
    assert.equal((await fetch(`${h.origin}/api/translation?sum_id=${accepted.sumId}&lang=es`)).status, 500);
    const body = await (await fetch(h.origin + "/api/p/" + accepted.sumId)).json(); const plan = adaptSummary(body).record.byLang.en!;
    assert.equal((await fetch(h.origin + "/api/read-aloud", post({ token: accepted.sumId, language: "en", text: speechTextFor(plan, "en").medsText }))).status, 500);
    assert.deepEqual((await h.ctx.summaries.get(accepted.sumId))?.translations, {});
  } finally { await h.close(); }
});

test("ElevenLabs sends the selected language and server-side key, validates audio and exposes no provider body", async () => {
  const h = await startLocalServer(0);
  try {
    h.ctx.config.ELEVENLABS_API_KEY = "UNIT_TEST_KEY";
    let calls = 0;
    const provider = new ElevenLabsReadAloud(h.ctx.config, (async (url, init) => {
      calls++; assert.ok(String(url).includes("/text-to-speech/")); assert.equal((init!.headers as Record<string, string>)["xi-api-key"], "UNIT_TEST_KEY");
      assert.deepEqual(JSON.parse(init!.body as string), { text: "Synthetic text", model_id: "eleven_multilingual_v2", language_code: "ar" });
      return new Response("audio", { headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch);
    assert.equal((await provider.synthesize("Synthetic text", "ar")).toString(), "audio"); assert.equal(calls, 1);
    const denied = new ElevenLabsReadAloud(h.ctx.config, (async () => new Response("private provider detail", { status: 401 })) as typeof fetch);
    await assert.rejects(denied.synthesize("x", "en"), /^Error: ElevenLabs returned HTTP 401$/);
    const nonAudio = new ElevenLabsReadAloud(h.ctx.config, (async () => new Response("{}", { headers: { "content-type": "application/json" } })) as typeof fetch);
    await assert.rejects(nonAudio.synthesize("x", "en"), /non-audio/);
  } finally { await h.close(); }
});

test("HealthScribe consumes conversation segments and deletes staged files and job metadata", async () => {
  const commands: string[] = []; let job = ""; const deleted: string[] = [];
  const s3 = { async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    commands.push(command.constructor.name);
    if (command.constructor.name === "DeleteObjectCommand") deleted.push(String(command.input.Key));
    if (command.constructor.name === "GetObjectCommand") return { Body: { transformToString: async () => JSON.stringify({ Conversation: { TranscriptSegments: [
      { Content: "Synthetic doctor instructions.", ParticipantDetails: { ParticipantRole: "CLINICIAN" } }, { Content: "Thank you.", ParticipantDetails: { ParticipantRole: "PATIENT" } },
    ] } }) } }; return {};
  } } as unknown as S3Client;
  const tx = { async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    commands.push(command.constructor.name); job = String(command.input.MedicalScribeJobName);
    if (command.constructor.name === "StartMedicalScribeJobCommand") assert.equal(command.input.OutputBucketName, "test-bucket");
    if (command.constructor.name === "GetMedicalScribeJobCommand") return { MedicalScribeJob: { MedicalScribeJobStatus: "COMPLETED", MedicalScribeOutput: {
      TranscriptFileUri: `https://s3.us-east-1.amazonaws.com/test-bucket/${job}/transcript.json`, ClinicalDocumentUri: `s3://test-bucket/${job}/summary.json`,
    } } }; return {};
  } } as unknown as TranscribeClient;
  const speech = new HealthScribeSpeechToText({ region: "us-east-1", bucket: "test-bucket", roleArn: "test-role", s3, transcribe: tx, pollIntervalMs: 1 });
  const result = await speech.transcribe({ audio: Buffer.from("synthetic audio"), mimeType: "audio/mpeg", fileName: "sample.mp3" });
  assert.equal(result.transcript, "CLINICIAN: Synthetic doctor instructions.\nPATIENT: Thank you."); assert.equal(result.provider, "healthscribe");
  assert.ok(commands.includes("DeleteMedicalScribeJobCommand")); assert.ok(deleted.includes(`${job}/transcript.json`)); assert.ok(deleted.includes(`${job}/summary.json`));
  assert.ok(deleted.some(key => key.startsWith("healthscribe/input/"))); assert.ok(deleted.includes(".write_access_check_file.temp"));
});

test("HealthScribe service rejection still cleans the input and never fabricates a transcript", async () => {
  const deleted: string[] = [];
  const s3 = { async send(c: { constructor: { name: string }; input: { Key?: string } }) { if (c.constructor.name === "DeleteObjectCommand") deleted.push(c.input.Key!); return {}; } } as unknown as S3Client;
  const tx = { async send() { throw new Error("Access denied"); } } as unknown as TranscribeClient;
  const speech = new HealthScribeSpeechToText({ region: "us-east-1", bucket: "test-bucket", roleArn: "test-role", s3, transcribe: tx });
  await assert.rejects(speech.transcribe({ audio: Buffer.from("test"), mimeType: "audio/mpeg" }), /Access denied/);
  assert.ok(deleted.some(key => key.startsWith("healthscribe/input/")));
});

test("local patient records, active links, documents and audio survive a restart and still expire", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dischargeai-persistence-"));
  let h = await startLocalServer(0, { dataDir: directory });
  try {
    const accepted = await (await fetch(h.origin + "/api/ingest", ingest("Persistent synthetic visit"))).json(); await h.ctx.queue.onIdle();
    await fetch(h.origin + "/api/patients", post({ ID: "persist", DOB: "2000-01-01" }));
    await h.ctx.audio.put({ key: "test-audio", body: Buffer.from("test"), contentType: "audio/mpeg" });
    await h.close(); h = await startLocalServer(0, { dataDir: directory });
    assert.equal((await fetch(h.origin + "/api/p/" + accepted.sumId)).status, 200);
    assert.ok(await h.ctx.patients.getById("persist")); assert.equal((await h.ctx.audio.get("test-audio"))?.body.toString(), "test");
    const appended = await (await fetch(h.origin + "/api/ingest", ingest("After restart"))).json(); assert.equal(appended.sumId, accepted.sumId); await h.ctx.queue.onIdle();
    h.ctx.clock.advanceDays(31); assert.equal((await fetch(h.origin + "/api/p/" + accepted.sumId)).status, 410); await h.ctx.purge();
    assert.equal(await h.ctx.summaries.get(accepted.sumId), null);
  } finally { await h.close(); rmSync(directory, { recursive: true }); }
});
