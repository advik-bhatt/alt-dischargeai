import { startLocalServer } from "./local-server.js";
import { createLocalLiveAgent } from "./local/agentcore.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { AiInfraTranslator } from "../src/pipeline/translation.js";
import { ElevenLabsReadAloud } from "../src/pipeline/readAloud.js";
import { createSpeechToText } from "../src/pipeline/speechToText.js";
import { createLogger } from "../src/logger.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();

const agent = createLocalLiveAgent();
const port = Number(process.env.LOCAL_TEST_PORT ?? "4000");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("LOCAL_TEST_PORT must be 1–65535");
try {
  const speech = config.SPEECH_PROVIDER === "healthscribe" && config.HEALTHSCRIBE_BUCKET && config.HEALTHSCRIBE_ROLE_ARN ? await createSpeechToText(config, createLogger("silent")) : undefined;
  const local = await startLocalServer(port, { agent, speech, dataDir: resolve(process.env.LOCAL_DATA_DIR ?? "../.local-data"),
    translator: config.TRANSLATION_PROVIDER === "ai-infra" ? new AiInfraTranslator(config) : undefined,
    readAloud: config.ELEVENLABS_API_KEY ? new ElevenLabsReadAloud(config) : undefined });
  await local.ctx.purge();
  const purgeTimer = setInterval(() => { void local.ctx.purge().catch(error => console.error("Local purge failed:", error.message)); }, 60_000);
  purgeTimer.unref();
  console.log(`Local storage + LIVE AI: ${local.origin}\nAgentCore: ${agent.runtimeArn}\nDoctor: rivera@demo.health / demo1234\nSwagger: ${local.origin}/api/docs/ (provider key: local-test-key)\nSpeech: ${speech?.name ?? "unavailable"}; translation: ${local.ctx.translator?.name ?? "unavailable"}; read-aloud: ${local.ctx.readAloud?.name ?? "unavailable"}\nExternal provider permissions are checked when called. Emails are captured locally. Local data persists in .local-data and expires after 30 days.`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void local.close().then(() => { agent.close(); process.exit(0); });
  });
} catch (error) { agent.close(); throw error; }
