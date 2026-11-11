import type { AnswererApi, AnswerRequest, AnswerResult } from "@rovara-orch/workers";

export type ModelScript =
  | { kind: "answer"; answer: string; choice?: string | null; confidence?: string }
  | { kind: "refusal" }
  | { kind: "error"; message?: string }
  | { kind: "unparsable" };

/**
 * The answering model as the workers see it (the AnswererApi port), scripted. The real answerer's
 * own fallback rules (refusal, 3 tries, fixed reply) are tested against the model client in the
 * answerer package; here a script entry is the answerer's final result for one question.
 */
export class FakeModel implements AnswererApi {
  readonly requests: AnswerRequest[] = [];
  private readonly script: ModelScript[];

  constructor(script: ModelScript[] = []) {
    this.script = [...script];
  }

  async answer(req: AnswerRequest): Promise<AnswerResult> {
    this.requests.push(req);
    const s = this.script.shift() ?? { kind: "answer", answer: `Use ${req.choices[0] ?? "the simplest option that meets the spec"}.` };
    if (s.kind === "error") throw new Error(s.message ?? "model unavailable");
    if (s.kind === "refusal" || s.kind === "unparsable") {
      return { answer: "Follow the spec; choose the simplest option that meets it, and list the choice in the PR description.", choice: null, answeredBy: "fixed-reply", tries: 3, costUsd: 0, confidence: null, citations: [] };
    }
    return { answer: s.answer, choice: s.choice ?? null, answeredBy: req.modelId, tries: 1, costUsd: 0.01, confidence: s.confidence ?? "high", citations: [] };
  }
}
