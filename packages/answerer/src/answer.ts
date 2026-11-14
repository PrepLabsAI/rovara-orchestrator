import { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Answers the coding agent's mid-task questions (FR-027) with Claude Opus 5.5 on Amazon Bedrock
 * (research R8): adaptive thinking at effort high, structured output, the spec folder cached.
 * A refusal is retried on the fallback model by the SDK's client-side middleware (Bedrock has no
 * server-side fallbacks); a refusal after that, 3 failed tries, or unparsable output send the fixed reply.
 */
export const FIXED_REPLY = "Follow the spec; choose the simplest option that meets it, and list the choice in the PR description.";
export const DEFAULT_MODEL = "anthropic.claude-opus-5-5";
export const FALLBACK_MODEL = "anthropic.claude-opus-5";
export const MAX_TRIES = 3;

export const SYSTEM_PROMPT = [
  "You answer a coding agent's question about the task it is doing.",
  "Answer from the spec documents and tasks given.",
  "Choose the simplest option that meets the spec.",
  "When the spec does not decide, say which assumption you made, so it can be listed in the pull request.",
  "Never ask a question back.",
].join(" ");

export const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "confidence", "citations"],
  properties: {
    answer: { type: "string", minLength: 1, maxLength: 4000 },
    choice: { type: ["string", "null"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    citations: { type: "array", items: { type: "string" } },
  },
} as const;

const AnswerShape = z.object({
  answer: z.string().min(1).max(4000),
  choice: z.string().nullable().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  citations: z.array(z.string()),
});

/** The slice of the SDK's `client.beta.messages` the answerer uses. */
export interface MessagesApi {
  stream(params: Record<string, unknown>): {
    finalMessage(): Promise<{
      stop_reason: string | null;
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    }>;
  };
}

export interface AnswerRequest {
  question: string;
  choices: string[];
  specDocs: Array<{ path: string; content: string }>;
  tasks: Array<{ id: string; text: string }>;
  modelId: string;
}

export interface AnswerResult {
  answer: string;
  choice: string | null;
  answeredBy: string;
  tries: number;
  costUsd: number;
  confidence: string | null;
  citations: string[];
}

/** Estimated USD per token (Claude Opus 5.5 first-party rates; Bedrock prices may differ). */
const PRICE = { input: 4e-6, output: 20e-6, cacheRead: 0.2e-6, cacheWrite: 5e-6 };

export function estimateCost(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  return (
    u.input_tokens * PRICE.input +
    u.output_tokens * PRICE.output +
    (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead +
    (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite
  );
}

export function buildRequest(req: AnswerRequest): Record<string, unknown> {
  const spec = [
    "Spec documents:",
    ...req.specDocs.map((d) => `--- ${d.path} ---\n${d.content}`),
    "",
    "The node's tasks:",
    ...req.tasks.map((t) => t.text),
  ].join("\n");
  const question = [`Question: ${req.question}`, ...(req.choices.length ? [`Choices: ${req.choices.map((c) => JSON.stringify(c)).join(", ")}`] : [])].join("\n");
  return {
    model: req.modelId,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: ANSWER_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: spec, cache_control: { type: "ephemeral" } },
          { type: "text", text: question },
        ],
      },
    ],
  };
}

const fixed = (tries: number, costUsd: number): AnswerResult => ({ answer: FIXED_REPLY, choice: null, answeredBy: "fixed-reply", tries, costUsd, confidence: null, citations: [] });

export class Answerer {
  constructor(private readonly messages: MessagesApi) {}

  async answer(req: AnswerRequest): Promise<AnswerResult> {
    let cost = 0;
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      let final;
      try {
        final = await this.messages.stream(buildRequest(req)).finalMessage();
      } catch {
        continue; // API error: try again
      }
      cost += estimateCost(final.usage);
      if (final.stop_reason === "refusal") return fixed(tries, cost); // the fallback model refused too
      const text = final.content.find((b) => b.type === "text")?.text ?? "";
      let parsed;
      try {
        parsed = AnswerShape.safeParse(JSON.parse(text));
      } catch {
        continue;
      }
      if (!parsed.success) continue;
      const choice = parsed.data.choice && req.choices.includes(parsed.data.choice) ? parsed.data.choice : null;
      return { answer: parsed.data.answer, choice, answeredBy: req.modelId, tries, costUsd: cost, confidence: parsed.data.confidence, citations: parsed.data.citations };
    }
    return fixed(MAX_TRIES, cost);
  }
}

/** Options for `new AnthropicBedrockMantle(...)`, with the client-side refusal fallback registered. */
export function bedrockClientOptions(o: { awsRegion: string; fallbackModel?: string }) {
  return {
    awsRegion: o.awsRegion,
    middleware: [betaRefusalFallbackMiddleware([{ model: o.fallbackModel ?? FALLBACK_MODEL }])],
  };
}

/** The production answerer: Claude on Amazon Bedrock through the Mantle client. */
export async function bedrockAnswerer(o: { awsRegion: string; fallbackModel?: string }): Promise<Answerer> {
  const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
  const client = new AnthropicBedrockMantle(bedrockClientOptions(o));
  return new Answerer(client.beta.messages as unknown as MessagesApi);
}
