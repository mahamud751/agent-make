import type { Request } from "express";
import type { z } from "zod";

export const parse = <S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> => schema.parse(data);
export const body = <S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> => schema.parse(req.body ?? {});
export const query = <S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> => schema.parse(req.query ?? {});
export const param = (req: Request, name: string): string => String(req.params[name]);
