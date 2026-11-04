import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { actorLabel } from "../middleware/auth";
import type { RequestContext } from "../types";

export const audit = (ctx: RequestContext, action: string, target?: string, data: Prisma.InputJsonValue = {}) =>
  prisma.auditLog.create({ data: { tenantId: ctx.tenantId, actor: actorLabel(ctx), action, target, data } }).catch(() => {});
