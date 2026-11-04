import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";

export type LLMParams = Anthropic.Beta.MessageCreateParamsNonStreaming;
export type LLMMessage = Anthropic.Beta.BetaMessage;
export type LLMFn = (params: LLMParams) => Promise<LLMMessage>;

let client: Anthropic | null = null;

const defaultLLM: LLMFn = (params) => {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 120_000 });
  return client.beta.messages.create(params);
};

let impl: LLMFn = defaultLLM;

/** Swap the model backend (tests inject a scripted fake). */
export const setLLM = (fn: LLMFn | null) => {
  impl = fn ?? defaultLLM;
};

export const callLLM: LLMFn = (params) => impl(params);
