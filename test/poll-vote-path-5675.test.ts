/** Regression coverage for #5675: ESP-safe vote URLs. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

describe("#5675 — /vote/{edition}/{choice} transport-safe route", () => {
  it("normalizes the path form into the existing vote handler", async () => {
    const env = makePollEnv(makeTrackedKv());
    const response = await worker.fetch(
      new Request("https://poll.test/vote/260819/A?email=not-an-email"),
      env,
      {} as ExecutionContext,
    );

    assert.equal(response.status, 400);
    assert.match(await response.text(), /Link inválido/);
  });

  it("requires the same POLL_SECRET as the canonical /vote route", async () => {
    const env = makePollEnv(makeTrackedKv());
    env.POLL_SECRET = "";
    const response = await worker.fetch(
      new Request("https://poll.test/vote/260819/B?email=reader%40example.com"),
      env,
      {} as ExecutionContext,
    );

    assert.equal(response.status, 503);
    assert.match(await response.text(), /POLL_SECRET/);
  });
});
