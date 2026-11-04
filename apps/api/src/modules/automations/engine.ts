import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { conversationService } from "../conversations/service";
import { enqueue } from "../../jobs/queues";
import type { OrderDTO } from "../../connectors/types";

export const actionSchema = z.discriminatedUnion("type", [
  // message the customer in their latest conversation (or email them if none)
  z.object({ type: z.literal("notify_customer"), template: z.string().min(1).max(2000) }),
  // email someone on the team
  z.object({ type: z.literal("email"), to: z.string().email(), subject: z.string().max(200), template: z.string().max(5000) }),
  z.object({ type: z.literal("tag_conversation"), tag: z.string().max(50) }),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

/** {{order.number}}-style interpolation over the event payload (no code execution). */
export function render(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), data);
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Conditions are flat equality checks against the payload, e.g. {"to":"SHIPPED"} or {"order.status":"SHIPPED"}. */
export function matches(conditions: Record<string, unknown>, data: Record<string, unknown>): boolean {
  return Object.entries(conditions).every(([path, expected]) => {
    const v = path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), data);
    return Array.isArray(expected) ? expected.includes(v) : v === expected;
  });
}

export async function runAutomations(tenantId: string, event: string, data: Record<string, unknown>) {
  const rules = await prisma.automationRule.findMany({ where: { tenantId, event, active: true } });
  for (const rule of rules) {
    if (!matches((rule.conditions ?? {}) as Record<string, unknown>, data)) continue;
    const actions = z.array(actionSchema).safeParse(rule.actions);
    if (!actions.success) {
      logger.warn({ ruleId: rule.id }, "invalid automation actions");
      continue;
    }
    for (const action of actions.data) {
      try {
        await runAction(tenantId, action, data);
      } catch (err) {
        logger.error({ err, ruleId: rule.id }, "automation action failed");
      }
    }
    await prisma.auditLog.create({ data: { tenantId, actor: `automation:${rule.id}`, action: "automation.fired", target: event, data: { rule: rule.name } } });
  }
}

async function runAction(tenantId: string, action: AutomationAction, data: Record<string, unknown>) {
  const order = data.order as OrderDTO | undefined;
  switch (action.type) {
    case "notify_customer": {
      const text = render(action.template, data);
      const email = order?.customerEmail ?? undefined;
      const conv = email
        ? await prisma.conversation.findFirst({ where: { tenantId, OR: [{ verifiedEmail: email }, { customer: { email } }] }, orderBy: { lastMessageAt: "desc" } })
        : null;
      if (conv) await conversationService.addMessage(conv, "AGENT", text, { metadata: { automation: true } });
      else if (email) await enqueue("email.send", { tenantId, to: email, subject: order ? `Update on order #${order.number}` : "An update from us", text });
      return;
    }
    case "email":
      await enqueue("email.send", { tenantId, to: action.to, subject: render(action.subject, data), text: render(action.template, data) });
      return;
    case "tag_conversation": {
      const id = (data.conversation as { id?: string } | undefined)?.id ?? (data.conversationId as string | undefined);
      if (id) {
        const c = await prisma.conversation.findFirst({ where: { tenantId, id } });
        if (c && !c.tags.includes(action.tag)) await prisma.conversation.update({ where: { id }, data: { tags: { push: action.tag } } });
      }
    }
  }
}
