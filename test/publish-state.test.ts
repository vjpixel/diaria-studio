import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveBeehiivState,
  resolveLinkedInState,
  resolveFacebookState,
} from "../scripts/lib/publish-state.ts";

const NOW = new Date("2026-05-06T22:00:00Z");

describe("resolveBeehiivState (#782)", () => {
  it("draft → draft", () => {
    assert.equal(resolveBeehiivState({ status: "draft" }, NOW), "draft");
  });

  it("confirmed + publish_date no passado → published", () => {
    const past = NOW.getTime() / 1000 - 3600; // 1h atrás
    assert.equal(
      resolveBeehiivState({ status: "confirmed", publish_date: past }, NOW),
      "published",
    );
  });

  it("confirmed + publish_date no futuro → scheduled (#573 caso canônico)", () => {
    const future = NOW.getTime() / 1000 + 16 * 3600; // 16h futuro
    assert.equal(
      resolveBeehiivState({ status: "confirmed", publish_date: future }, NOW),
      "scheduled",
    );
  });

  it("confirmed + publish_date == now → published (boundary)", () => {
    const exact = NOW.getTime() / 1000;
    assert.equal(
      resolveBeehiivState({ status: "confirmed", publish_date: exact }, NOW),
      "published",
    );
  });

  it("confirmed + publish_date 1s no futuro → scheduled (boundary)", () => {
    const justFuture = NOW.getTime() / 1000 + 1;
    assert.equal(
      resolveBeehiivState({ status: "confirmed", publish_date: justFuture }, NOW),
      "scheduled",
    );
  });

  it("confirmed sem publish_date → unknown (defensive)", () => {
    assert.equal(resolveBeehiivState({ status: "confirmed" }, NOW), "unknown");
    assert.equal(
      resolveBeehiivState({ status: "confirmed", publish_date: null }, NOW),
      "unknown",
    );
    assert.equal(
      resolveBeehiivState({ status: "confirmed", publish_date: 0 }, NOW),
      "unknown",
    );
  });

  it("archived → unknown", () => {
    assert.equal(resolveBeehiivState({ status: "archived" }, NOW), "unknown");
  });

  it("status desconhecido → unknown", () => {
    assert.equal(resolveBeehiivState({ status: "weird_new" }, NOW), "unknown");
    assert.equal(resolveBeehiivState({}, NOW), "unknown");
  });

  it("status com case mixed é normalizado", () => {
    const past = NOW.getTime() / 1000 - 100;
    assert.equal(
      resolveBeehiivState({ status: "Confirmed", publish_date: past }, NOW),
      "published",
    );
  });
});

describe("resolveLinkedInState (#782)", () => {
  it("draft → draft", () => {
    assert.equal(resolveLinkedInState({ status: "draft" }, NOW), "draft");
  });

  it("published/sent → published", () => {
    assert.equal(resolveLinkedInState({ status: "published" }, NOW), "published");
    assert.equal(resolveLinkedInState({ status: "sent" }, NOW), "published");
  });

  it("failed/error → unknown", () => {
    assert.equal(resolveLinkedInState({ status: "failed" }, NOW), "unknown");
    assert.equal(resolveLinkedInState({ status: "error" }, NOW), "unknown");
  });

  it("scheduled + scheduled_at no futuro → scheduled", () => {
    assert.equal(
      resolveLinkedInState(
        { status: "scheduled", scheduled_at: "2026-05-07T09:00:00-03:00" },
        NOW,
      ),
      "scheduled",
    );
  });

  it("scheduled + scheduled_at no passado → published (drift detect)", () => {
    assert.equal(
      resolveLinkedInState(
        { status: "scheduled", scheduled_at: "2026-05-05T09:00:00-03:00" },
        NOW,
      ),
      "published",
    );
  });

  it("scheduled sem scheduled_at → trust o status", () => {
    assert.equal(
      resolveLinkedInState({ status: "scheduled" }, NOW),
      "scheduled",
    );
  });

  it("scheduled com timestamp inválido → trust o status (defensive)", () => {
    assert.equal(
      resolveLinkedInState(
        { status: "scheduled", scheduled_at: "not-a-date" },
        NOW,
      ),
      "scheduled",
    );
  });

  it("status desconhecido → unknown", () => {
    assert.equal(resolveLinkedInState({ status: "weird" }, NOW), "unknown");
    assert.equal(resolveLinkedInState({}, NOW), "unknown");
  });
});

describe("resolveFacebookState (#782)", () => {
  it("delega pra resolveLinkedInState (formato local idêntico)", () => {
    assert.equal(resolveFacebookState({ status: "draft" }, NOW), "draft");
    assert.equal(
      resolveFacebookState(
        { status: "scheduled", scheduled_at: "2026-05-07T09:00:00-03:00" },
        NOW,
      ),
      "scheduled",
    );
    assert.equal(resolveFacebookState({ status: "failed" }, NOW), "unknown");
  });
});
