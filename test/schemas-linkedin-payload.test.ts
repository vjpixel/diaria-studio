import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseMakeWebhookPayload,
  parseMakeWebhookResponse,
  parseWorkerQueueResponse,
} from "../scripts/lib/schemas/linkedin-payload.ts";

/**
 * Tests pra schemas de payload LinkedIn (#1032).
 */

describe("parseMakeWebhookPayload", () => {
  it("payload válido com image_url string", () => {
    const r = parseMakeWebhookPayload({
      text: "Post text",
      image_url: "https://example.com/img.jpg",
      scheduled_at: "2026-05-10T12:00:00Z",
      destaque: "d1",
    });
    assert.equal(r.text, "Post text");
    assert.equal(r.image_url, "https://example.com/img.jpg");
  });

  it("payload válido com image_url null (post sem imagem)", () => {
    const r = parseMakeWebhookPayload({
      text: "Post text",
      image_url: null,
      scheduled_at: null,
      destaque: "d2",
    });
    assert.equal(r.image_url, null);
  });

  it("rejeita payload com image_url undefined (#974 DLQ bug-driver)", () => {
    assert.throws(() =>
      parseMakeWebhookPayload({
        text: "Post text",
        // image_url ausente — Make recusa
        scheduled_at: null,
        destaque: "d1",
      }),
    );
  });

  it("rejeita text vazio", () => {
    assert.throws(() =>
      parseMakeWebhookPayload({
        text: "",
        image_url: null,
        scheduled_at: null,
        destaque: "d1",
      }),
    );
  });

  it("aceita campos extras (passthrough — Make pode aceitar campos novos)", () => {
    const r = parseMakeWebhookPayload({
      text: "Post text",
      image_url: null,
      scheduled_at: null,
      destaque: "d1",
      campo_novo: "valor",
    });
    assert.equal((r as { campo_novo?: string }).campo_novo, "valor");
  });
});

describe("parseMakeWebhookResponse", () => {
  it("response com request_id + accepted", () => {
    const r = parseMakeWebhookResponse({
      request_id: "req-123",
      accepted: true,
    });
    assert.equal(r.request_id, "req-123");
    assert.equal(r.accepted, true);
  });

  it("response vazio é válido (Make às vezes retorna {})", () => {
    const r = parseMakeWebhookResponse({});
    assert.equal(r.request_id, undefined);
  });

  it("aceita campos extras", () => {
    const r = parseMakeWebhookResponse({
      accepted: true,
      meta: { trace_id: "abc" },
    });
    assert.ok(r);
  });
});

describe("parseWorkerQueueResponse", () => {
  it("response válido com queued: true", () => {
    const r = parseWorkerQueueResponse({
      queued: true,
      key: "post:260508:d1",
      scheduled_at: "2026-05-10T12:00:00Z",
      destaque: "d1",
    });
    assert.equal(r.queued, true);
    assert.equal(r.key, "post:260508:d1");
  });

  it("rejeita queued: false (silent partial enqueue)", () => {
    assert.throws(() =>
      parseWorkerQueueResponse({
        queued: false,
        key: "x",
        scheduled_at: "2026-05-10T12:00:00Z",
        destaque: "d1",
      }),
    );
  });

  it("rejeita response sem key", () => {
    assert.throws(() =>
      parseWorkerQueueResponse({
        queued: true,
        scheduled_at: "2026-05-10T12:00:00Z",
        destaque: "d1",
      }),
    );
  });
});
