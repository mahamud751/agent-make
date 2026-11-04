import { registerFailureHandler, registerHandler } from "./queues";
import { handleAgentFailure, runAgentTurn } from "../agent/runtime";
import { deliverWebhook } from "../modules/webhooks/delivery";
import { runAutomations } from "../modules/automations/engine";
import { approvalService } from "../modules/approvals/service";
import { sendEmail } from "../modules/channels/email";
import { sendWhatsApp } from "../modules/channels/whatsapp";
import { prisma } from "../lib/prisma";

let registered = false;

/** Wire job names to implementations (shared by the worker and inline mode). */
export function registerJobHandlers() {
  if (registered) return;
  registered = true;
  registerHandler("agent.reply", async ({ conversationId, messageId }) => runAgentTurn(conversationId, messageId));
  registerHandler("webhook.deliver", async ({ deliveryId }) => deliverWebhook(deliveryId));
  registerHandler("automation.run", async ({ tenantId, event, data }) => runAutomations(tenantId, event, data));
  registerHandler("action.execute", async ({ actionId, userId }) => {
    const a = await prisma.pendingAction.findUnique({ where: { id: actionId } });
    if (a) await approvalService.approve(a.tenantId, actionId, userId);
  });
  registerHandler("email.send", async (job) => sendEmail(job));
  registerFailureHandler("agent.reply", async ({ conversationId }) => handleAgentFailure(conversationId));
  registerHandler("whatsapp.send", async (job) => sendWhatsApp(job));
}
