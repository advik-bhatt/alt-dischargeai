import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";

/** Express 5 routes async errors here without wrappers. zod -> 400, AppError -> its status, else 500. */
export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation_error", issues: err.issues });
      return;
    }
    if (err instanceof AppError) {
      const body: Record<string, unknown> = { error: err.code, message: err.message };
      if (err.details !== undefined) Object.assign(body, err.details);
      res.status(err.status).json(body);
      return;
    }
    const anyErr = err as { code?: string; type?: string; status?: number; message?: string };
    if (anyErr?.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "file_too_large", message: anyErr.message });
      return;
    }
    if (anyErr?.type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    log.error({ err: { name: (err as Error)?.name, message: (err as Error)?.message } }, "unhandled error");
    res.status(500).json({ error: "internal_error" });
  };
}
