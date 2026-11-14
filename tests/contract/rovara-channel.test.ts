import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";
import { ChannelDecisionSchema, ChannelEventSchema, InboundMessageSchema } from "@rovara-orch/rovara";

const root = new URL("../../", import.meta.url).pathname;
const cache = `${root}.cache/rovara/packages/contracts/src`;
type Schema = { safeParse(v: unknown): { success: boolean; error?: unknown } };
let rovara: { ChannelEventSchema: Schema; InboundMessageSchema: Schema; ChannelDecisionSchema: Schema };
let fixtures: { events: unknown[]; message: unknown; decision: unknown };

beforeAll(async () => {
  execFileSync(`${root}scripts/fetch-rovara-contracts.sh`, { stdio: "inherit" });
  if (!existsSync(`${cache}/channel-adapter.ts`)) throw new Error("Rovara contracts were not fetched");
  const adapter = await import(/* @vite-ignore */ `${cache}/channel-adapter.ts`);
  const conversation = await import(/* @vite-ignore */ `${cache}/conversation.ts`);
  rovara = { ChannelEventSchema: adapter.ChannelEventSchema, ChannelDecisionSchema: adapter.ChannelDecisionSchema, InboundMessageSchema: conversation.InboundMessageSchema };
  fixtures = JSON.parse(await readFile(new URL("./fixtures/rovara/channel.json", import.meta.url), "utf8"));
}, 300_000);

describe("pinned Rovara channel contract", () => {
  test("every event fixture parses with Rovara's schema and with our copy", () => {
    expect(fixtures.events.length).toBe(10);
    for (const e of fixtures.events) {
      const theirs = rovara.ChannelEventSchema.safeParse(e);
      expect(theirs.success, JSON.stringify(theirs.error)).toBe(true);
      expect(ChannelEventSchema.safeParse(e).success).toBe(true);
    }
  });

  test("every request we build parses with Rovara's schema", () => {
    expect(InboundMessageSchema.safeParse(fixtures.message).success).toBe(true);
    const m = rovara.InboundMessageSchema.safeParse(fixtures.message);
    expect(m.success, JSON.stringify(m.error)).toBe(true);
    expect(ChannelDecisionSchema.safeParse(fixtures.decision).success).toBe(true);
    const d = rovara.ChannelDecisionSchema.safeParse(fixtures.decision);
    expect(d.success, JSON.stringify(d.error)).toBe(true);
  });

  test("our copy is no looser than Rovara's on the fields we rely on", () => {
    const bad = [
      { ...(fixtures.events[5] as object), data: { text: "x", status: "green" } },
      { ...(fixtures.events[0] as object), id: "not-an-event-id" },
    ];
    for (const e of bad) {
      expect(rovara.ChannelEventSchema.safeParse(e).success).toBe(false);
      expect(ChannelEventSchema.safeParse(e).success).toBe(false);
    }
  });
});
