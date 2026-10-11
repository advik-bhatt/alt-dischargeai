import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../app.js";
import { attachDictationSocket } from "../dictationSocket.js";
import { createHostedContext } from "./context.js";

// The hosted entrypoint (Dockerfile.vercel runs this). One origin serves the built UI and /api.
if (!existsSync(join(import.meta.dirname, "..", "..", "..", "frontend", "dist", "index.html"))) {
  throw new Error("frontend/dist is missing: build the frontend before starting the hosted server.");
}
const ctx = await createHostedContext();
const app = buildApp(ctx);
ctx.startPurgeTimer();
const server = app.listen(ctx.config.PORT, ctx.config.HOST, () => {
  ctx.log.info({ port: ctx.config.PORT, node: process.version }, `DischargeAI hosted server listening on ${ctx.config.HOST}:${ctx.config.PORT}`);
});
const dictation = attachDictationSocket(server, ctx);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    ctx.log.info({ signal }, "shutting down");
    dictation.close();
    server.close();
    void ctx.close().finally(() => process.exit(0));
  });
}
