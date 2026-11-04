import type Anthropic from "@anthropic-ai/sdk";
import type { ActionPolicy, Agent, Conversation } from "@prisma/client";
import type { z } from "zod";
import type { CommerceConnector } from "../../connectors/types";

export interface Guardrails {
  maxRefundAmount?: number; // refunds above this always need approval
  handoffKeywords?: string[];
  allowOrderCreation?: boolean;
}

export interface ToolContext {
  tenantId: string;
  agent: Agent;
  conversation: Conversation; // mutated in place when the customer verifies identity
  connector: CommerceConnector;
  actor: string;
  guardrails: Guardrails;
  /** true when executing a human-approved PendingAction */
  approved?: boolean;
}

export type ToolResult = { ok: true; data: unknown; customerNotice?: string } | { ok: false; error: string };

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  inputSchema: Anthropic.Beta.BetaTool["input_schema"];
  defaultPolicy: ActionPolicy;
  /** Validate preconditions without side effects (used before queueing for approval). */
  precheck?(ctx: ToolContext, input: z.infer<S>): Promise<string | null>;
  /** Whether this call must go to a human even if policy is AUTO (e.g. refund above limit). */
  forceApproval?(ctx: ToolContext, input: z.infer<S>): boolean;
  run(ctx: ToolContext, input: z.infer<S>): Promise<ToolResult>;
}

export const ok = (data: unknown, customerNotice?: string): ToolResult => ({ ok: true, data, customerNotice });
export const fail = (error: string): ToolResult => ({ ok: false, error });

/** Preserves per-tool input inference while storing tools in one array. */
export const defineTool = <S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;
