import { it } from "node:test";
import assert from "node:assert/strict";
import { LinkedInScheduler, type DoStoredPayload } from "../src/durable-object.ts";
import { CLAIM_TTL_MS } from "../src/index.ts";

function setup() {
  const values = new Map<string, unknown>();
  let alarms = 0;
  let tail = Promise.resolve();
  const state = {
    storage: {
      async get(k: string) { return values.get(k); },
      async put(k: string, v: unknown) { values.set(k, v); },
      async delete(k: string) { values.delete(k); },
      async setAlarm() { alarms++; },
    },
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn);
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
  const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
  const payload = {
    key: "queue:reels", webhookUrl: "https://example.test",
    entry: { text: "old", channel: "instagram", media_type: "REELS", video_url: "https://example.test/video.mp4" },
  } as DoStoredPayload;
  values.set("payload", payload);
  values.set("reels_container", { id: "original" });
  const arm = () => scheduler.fetch(new Request("https://do/arm", {
    method: "POST", body: JSON.stringify({ ...payload, entry: { ...payload.entry, text: "new" }, scheduledAtMs: Date.now() }),
  }));
  return { values, scheduler, payload, arm, alarms: () => alarms };
}

for (const path of ["alarm", "cron"] as const) {
  it(`#11035 /arm preserva payload/container durante claim de ${path}`, async () => {
    const ctx = setup();
    if (path === "alarm") assert.equal(await ctx.scheduler.tryClaim(), true);
    else assert.equal((await (await ctx.scheduler.fetch(new Request("https://do/claim", { method: "POST" }))).json()).claimed, true);
    const res = await ctx.arm();
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { armed: false, claiming: true });
    assert.equal(ctx.values.get("payload"), ctx.payload);
    assert.deepEqual(ctx.values.get("reels_container"), { id: "original" });
    assert.equal(ctx.alarms(), 0);
  });
}

it("#11035 /arm e aquisição do claim concorrentes usam a mesma exclusão", async () => {
  const ctx = setup();
  const claim = ctx.scheduler.tryClaim();
  const arm = ctx.arm();
  assert.equal(await claim, true);
  assert.equal((await arm).status, 409);
  assert.equal(ctx.values.get("payload"), ctx.payload);
});

it("#11035 claim expirado permite rearmar após crash; fired continua recusado", async () => {
  const ctx = setup();
  ctx.values.set("claiming", true);
  ctx.values.set("claimed_at", Date.now() - CLAIM_TTL_MS - 1000);
  assert.equal((await ctx.arm()).status, 200);
  assert.equal(ctx.values.has("reels_container"), false);
  ctx.values.set("fired", true);
  assert.deepEqual(await (await ctx.arm()).json(), { armed: false, fired: true });
});
