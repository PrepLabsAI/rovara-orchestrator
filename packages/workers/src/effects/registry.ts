import type { IntentEffect } from "@rovara-orch/core";
import { githubComment } from "./github-comment.js";
import { githubEnqueue } from "./github-enqueue.js";
import { githubPr } from "./github-pr.js";
import { githubReview } from "./github-review.js";
import { modelAnswer } from "./model-answer.js";
import { queueEnqueue } from "./queue-enqueue.js";
import { rovaraCancel } from "./rovara-cancel.js";
import { rovaraClose } from "./rovara-close.js";
import { rovaraDecision } from "./rovara-decision.js";
import { rovaraSend } from "./rovara-send.js";
import { rovaraWorkspaceLimit } from "./rovara-workspace-limit.js";
import { slack } from "./slack.js";
import type { Executor } from "./types.js";

export const EXECUTORS: Record<IntentEffect, Executor> = {
  "rovara.message": rovaraSend,
  "rovara.decision": rovaraDecision,
  "rovara.close": rovaraClose,
  "rovara.cancel": rovaraCancel,
  "rovara.workspace_limit": rovaraWorkspaceLimit,
  "github.enqueue": githubEnqueue,
  "github.resolve_thread": githubReview,
  "github.comment": githubComment,
  "github.close_pr": githubPr,
  "slack.post": slack,
  "slack.reply": slack,
  "model.answer": modelAnswer,
  "queue.enqueue": queueEnqueue,
};
