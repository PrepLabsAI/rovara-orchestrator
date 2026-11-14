import { describe, expect, test } from "vitest";
import { Answerer, bedrockClientOptions, FIXED_REPLY, type MessagesApi } from "./answer.js";

type Script = Array<{ text?: string; stop?: string; error?: boolean }>;

/** A fake of the SDK's `client.beta.messages`: scripted final messages, recording each request. */
function fakeMessages(script: Script): MessagesApi & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    stream(params) {
      requests.push(params);
      const step = script.shift() ?? { text: '{"answer":"default","choice":null,"confidence":"high","citations":[]}' };
      return {
        finalMessage: async () => {
          if (step.error) throw new Error("529 overloaded");
          return {
            stop_reason: step.stop ?? "end_turn",
            content: step.text !== undefined ? [{ type: "text", text: step.text }] : [],
            usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
          };
        },
      };
    },
  };
}

const req = (choices: string[] = []) => ({
  question: "Should tokens expire after 24 hours or 7 days?",
  choices,
  specDocs: [{ path: "specs/001/spec.md", content: "Sessions last 24 hours." }],
  tasks: [{ id: "T010", text: "- [ ] T010 Create the session store" }],
  modelId: "anthropic.claude-opus-5-5",
});
const json = (o: unknown) => JSON.stringify(o);

describe("Answerer", () => {
  test("a structured answer is sent unchanged", async () => {
    const m = fakeMessages([{ text: json({ answer: "Use 24 hours, as the spec says.", choice: "24 hours", confidence: "high", citations: ["specs/001/spec.md"] }) }]);
    const r = await new Answerer(m).answer(req(["24 hours", "7 days"]));
    expect(r).toMatchObject({ answer: "Use 24 hours, as the spec says.", choice: "24 hours", answeredBy: "anthropic.claude-opus-5-5", tries: 1, confidence: "high" });
    expect(r.costUsd).toBeGreaterThan(0);
  });

  test("the request: adaptive thinking, effort high, the JSON schema, the spec cached, the question last", async () => {
    const m = fakeMessages([{ text: json({ answer: "x", choice: null, confidence: "low", citations: [] }) }]);
    await new Answerer(m).answer(req());
    const p = m.requests[0] as {
      model: string;
      thinking: unknown;
      output_config: { effort: string; format: { type: string; schema: { required: string[] } } };
      system: string;
      messages: Array<{ content: Array<{ text: string; cache_control?: unknown }> }>;
    };
    expect(p.model).toBe("anthropic.claude-opus-5-5");
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config.effort).toBe("high");
    expect(p.output_config.format.type).toBe("json_schema");
    expect(p.output_config.format.schema.required).toEqual(["answer", "confidence", "citations"]);
    expect(p.system).toMatch(/never ask a question back/i);
    const [spec, question] = p.messages[0]!.content;
    expect(spec!.text).toContain("Sessions last 24 hours.");
    expect(spec!.cache_control).toEqual({ type: "ephemeral" });
    expect(question!.text).toContain("Should tokens expire");
  });

  test("a choice not among the offered choices is dropped", async () => {
    const m = fakeMessages([{ text: json({ answer: "Use 12 hours.", choice: "12 hours", confidence: "medium", citations: [] }) }]);
    const r = await new Answerer(m).answer(req(["24 hours", "7 days"]));
    expect(r.choice).toBeNull();
    expect(r.answer).toBe("Use 12 hours.");
  });

  test("a refusal (after the client-side fallback) sends the fixed reply", async () => {
    const r = await new Answerer(fakeMessages([{ stop: "refusal" }])).answer(req());
    expect(r).toMatchObject({ answer: FIXED_REPLY, answeredBy: "fixed-reply" });
  });

  test("the production client registers the client-side refusal fallback middleware", () => {
    const o = bedrockClientOptions({ awsRegion: "us-east-1" });
    expect(o.awsRegion).toBe("us-east-1");
    expect(o.middleware).toHaveLength(1);
  });

  test("3 API errors send the fixed reply", async () => {
    const m = fakeMessages([{ error: true }, { error: true }, { error: true }]);
    const r = await new Answerer(m).answer(req());
    expect(r).toMatchObject({ answer: FIXED_REPLY, answeredBy: "fixed-reply", tries: 3 });
    expect(m.requests).toHaveLength(3);
  });

  test("an error then a good answer uses the answer", async () => {
    const m = fakeMessages([{ error: true }, { text: json({ answer: "ok", choice: null, confidence: "high", citations: [] }) }]);
    expect(await new Answerer(m).answer(req())).toMatchObject({ answer: "ok", tries: 2 });
  });

  test("unparsable output sends the fixed reply", async () => {
    const m = fakeMessages([{ text: "not json" }, { text: '{"answer": 5}' }, { text: "" }]);
    expect(await new Answerer(m).answer(req())).toMatchObject({ answer: FIXED_REPLY, answeredBy: "fixed-reply" });
  });

  test("the fixed reply is exact", () => {
    expect(FIXED_REPLY).toBe("Follow the spec; choose the simplest option that meets it, and list the choice in the PR description.");
  });
});
