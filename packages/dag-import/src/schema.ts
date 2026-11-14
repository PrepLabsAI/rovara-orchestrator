import { z } from "zod";

/**
 * The speckit-dag version-1 unit graph (speckit-dag schema/speckit-dag.schema.json).
 * Structural only: `version` and `unit` are checked separately, in the order validation reports.
 * Unknown fields are kept (producers may add their own data).
 */
const TaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    text: z.string(),
    ref: z.string(),
    files: z.array(z.string()),
  })
  .passthrough();

const NodeSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    kind: z.string().nullable().optional(),
    story: z.string().nullable().optional(),
    priority: z.string().nullable().optional(),
    mvp: z.boolean().optional(),
    files: z.array(z.string()).default([]),
    status: z.string().optional(),
    tasks: z.array(TaskSchema).default([]),
  })
  .passthrough();

const EdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    reasons: z.array(z.string()).default([]),
    via: z.array(z.object({ from: z.string(), to: z.string() }).passthrough()).optional(),
  })
  .passthrough();

const SpecSchema = z
  .object({
    id: z.string().optional(),
    repo: z.string().nullable(),
    branch: z.string().nullable().optional(),
    commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    dirty: z.boolean(),
    pushed: z.boolean(),
    dir: z.string(),
    docs: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();

export const GraphSchema = z
  .object({
    version: z.number(),
    unit: z.string(),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    feature: z.string().nullable().optional(),
    spec: SpecSchema,
    groups: z.array(z.record(z.string(), z.unknown())).default([]),
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema),
  })
  .passthrough();

export type Graph = z.infer<typeof GraphSchema>;
export type GraphNode = Graph["nodes"][number];
export type GraphEdge = Graph["edges"][number];
