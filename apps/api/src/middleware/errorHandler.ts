import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: "validation_error", message: "Invalid request", details: err.issues } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return res.status(409).json({ error: { code: "conflict", message: "Already exists" } });
    if (err.code === "P2025") return res.status(404).json({ error: { code: "not_found", message: "Not found" } });
  }
  logger.error({ err, path: req.path }, "unhandled error");
  res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
}
