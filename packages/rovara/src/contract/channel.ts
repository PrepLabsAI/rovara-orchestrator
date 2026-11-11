/**
 * Pinned copies of the Rovara channel-adapter shapes the orchestrator uses, from
 * packages/contracts/src/{conversation,channel-adapter}.ts at PINNED_ROVARA_COMMIT.
 * tests/contract/rovara-channel.test.ts checks them against Rovara's own schemas.
 */
import { z } from "zod";

export const ChannelIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
export const ChannelOpaqueIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:+@=-]+$/);

export const ConversationRefSchema = z
  .object({ channel: ChannelIdSchema, tenant: ChannelOpaqueIdSchema, space: ChannelOpaqueIdSchema, thread: ChannelOpaqueIdSchema })
  .strict();
export type ConversationRef = z.infer<typeof ConversationRefSchema>;

export const ActorRefSchema = z.object({ channel: ChannelIdSchema, tenant: ChannelOpaqueIdSchema, userId: ChannelOpaqueIdSchema }).strict();
export type ActorRef = z.infer<typeof ActorRefSchema>;

export const InboundMessageSchema = z
  .object({
    version: z.literal(2),
    channel: ChannelIdSchema,
    eventId: ChannelOpaqueIdSchema,
    conversation: ConversationRefSchema,
    actor: ActorRefSchema,
    text: z.string().min(1).max(40_000),
    receivedAt: z.string().datetime(),
  })
  .strict();
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const ChannelDecisionValueSchema = z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SKIP"]);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ChannelDecisionSchema = z
  .object({
    version: z.literal(1),
    channel: ChannelIdSchema,
    eventId: ChannelOpaqueIdSchema,
    conversation: ConversationRefSchema,
    actor: ActorRefSchema,
    requestId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    artifactDigest: DigestSchema,
    decision: ChannelDecisionValueSchema,
    reason: z.string().trim().min(1).max(500),
    receivedAt: z.string().datetime(),
  })
  .strict();
export type ChannelDecision = z.infer<typeof ChannelDecisionSchema>;

const Text = z.string().min(1).max(40_000);
const HttpsUrl = z.string().url().max(2_048).refine((url) => url.startsWith("https://"), "must be an https URL");
const ApprovalAction = z.object({ decision: ChannelDecisionValueSchema, label: z.string().min(1).max(80) }).strict();

/** Rich parts and actions (Rovara FR-070): accepted as opaque here; the orchestrator reads only `text`. */
const RichPart = z.object({ type: z.string() }).passthrough();
const richMessage = {
  text: Text,
  key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  parts: z.array(RichPart).max(50).optional(),
  actions: z.array(RichPart).max(25).optional(),
};

export const eventData = {
  ack: z.object({ inReplyTo: ChannelOpaqueIdSchema }).strict(),
  message: z.object({ ...richMessage, audience: z.object({ kind: z.string() }).passthrough().optional() }).strict(),
  progress: z.object({ text: Text }).strict(),
  question: z.object({ text: Text, choices: z.array(z.string().min(1).max(200)).max(10).optional() }).strict(),
  approval_request: z
    .object({
      text: Text,
      kind: z.enum(["plan_approval", "admin", "other"]),
      requestId: z.string().uuid(),
      expectedRevision: z.number().int().positive(),
      artifactDigest: DigestSchema,
      taskUrl: HttpsUrl.optional(),
      actions: z.array(ApprovalAction).min(1).max(4).optional(),
    })
    .strict(),
  check_report: z.object({ text: Text, status: z.enum(["passed", "failed", "unknown"]) }).strict(),
  pr: z.object({ url: HttpsUrl, title: z.string().min(1).max(300) }).strict(),
  done: z.object({ inReplyTo: ChannelOpaqueIdSchema.optional(), text: Text.optional() }).strict(),
  error: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), text: Text }).strict(),
  link_required: z.object({ linkUrl: HttpsUrl, expiresAt: z.string().datetime(), actor: ActorRefSchema }).strict(),
} as const;

const eventBase = {
  version: z.literal(1),
  id: z.string().regex(/^evt_[A-Za-z0-9_-]{16,64}$/),
  channel: ChannelIdSchema,
  conversation: ConversationRefSchema,
  createdAt: z.string().datetime(),
};

export const ChannelEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("ack"), data: eventData.ack }).strict(),
  z.object({ ...eventBase, type: z.literal("message"), data: eventData.message }).strict(),
  z.object({ ...eventBase, type: z.literal("progress"), data: eventData.progress }).strict(),
  z.object({ ...eventBase, type: z.literal("question"), data: eventData.question }).strict(),
  z.object({ ...eventBase, type: z.literal("approval_request"), data: eventData.approval_request }).strict(),
  z.object({ ...eventBase, type: z.literal("check_report"), data: eventData.check_report }).strict(),
  z.object({ ...eventBase, type: z.literal("pr"), data: eventData.pr }).strict(),
  z.object({ ...eventBase, type: z.literal("done"), data: eventData.done }).strict(),
  z.object({ ...eventBase, type: z.literal("error"), data: eventData.error }).strict(),
  z.object({ ...eventBase, type: z.literal("link_required"), data: eventData.link_required }).strict(),
]);
export type ChannelEvent = z.infer<typeof ChannelEventSchema>;

/** Rovara's `direct` event (a message to a person outside any conversation): not for the orchestrator, ignored. */
export const DirectEventSchema = z
  .object({ version: z.literal(1), id: z.string(), channel: ChannelIdSchema, type: z.literal("direct"), to: ActorRefSchema, createdAt: z.string() })
  .passthrough();
