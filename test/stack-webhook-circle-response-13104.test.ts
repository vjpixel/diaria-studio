/**
 * #13104 — `sendStackPost` aceita também a resposta da Admin API v2 do Circle
 * repassada sem mexer (`{ message, post: { id, slug, url } }`): `post.id`
 * numérico prova a publicação. Antes só `ok === true` no topo contava, e um
 * post publicado de verdade virava "não confirmado" (ciclo ambíguo, risco de
 * republicar).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStackPostPayload,
  extractStackPostIdentity,
  isStackPostConfirmed,
  sendStackPost,
} from "../scripts/lib/stack-webhook.ts";
import { publishCircleStackCycle } from "../scripts/publish-circle-stack.ts";

const CIRCLE_RESPONSE = {
  message: "Post created.",
  post: { id: 987654, slug: "radar-26w46", url: "https://plataforma.stack.com.br/c/radar/radar-26w46" },
};

const fakeFetch = (status: number, body: string) =>
  (async () => new Response(body, { status })) as typeof fetch;

describe("#13104 — confirmação do post pela resposta do Circle", () => {
  it("isStackPostConfirmed aceita os dois formatos e recusa o resto", () => {
    assert.equal(isStackPostConfirmed({ ok: true }), true);
    assert.equal(isStackPostConfirmed(CIRCLE_RESPONSE), true);
    assert.equal(isStackPostConfirmed({}), false);
    assert.equal(isStackPostConfirmed({ message: "Post created." }), false);
    assert.equal(isStackPostConfirmed({ post: { id: "987654" } }), false, "id em string não é prova");
    assert.equal(isStackPostConfirmed({ post: { id: 0 } }), false);
    assert.equal(isStackPostConfirmed({ post: { id: 1.5 } }), false);
    assert.equal(isStackPostConfirmed({ ok: false, post: { id: 1 } }), false, "ok:false explícito vence");
    assert.equal(isStackPostConfirmed([{ ok: true }]), false);
    assert.equal(isStackPostConfirmed(null), false);
  });

  it("formato n8n ({ok:true}): segue confirmado, sem id/slug", async () => {
    const r = await sendStackPost("https://hook.test", "k", buildStackPostPayload("T", "Corpo"), fakeFetch(200, '{"ok": true}'));
    assert.deepEqual(r, { postUrl: null, postId: null, postSlug: null });
  });

  it("formato Circle (post.id): confirmado, com url, id e slug", async () => {
    const r = await sendStackPost(
      "https://hook.test",
      "k",
      buildStackPostPayload("T", "Corpo"),
      fakeFetch(200, JSON.stringify(CIRCLE_RESPONSE)),
    );
    assert.deepEqual(r, {
      postUrl: "https://plataforma.stack.com.br/c/radar/radar-26w46",
      postId: 987654,
      postSlug: "radar-26w46",
    });
  });

  it("Circle sem url: id e slug ainda vêm", () => {
    assert.deepEqual(extractStackPostIdentity({ post: { id: 5, slug: "  x  " } }), { postId: 5, postSlug: "x" });
    assert.deepEqual(extractStackPostIdentity({ ok: true }), { postId: null, postSlug: null });
  });

  it("2xx sem prova segue recusado", async () => {
    await assert.rejects(
      sendStackPost("https://hook.test", "k", buildStackPostPayload("T", "Corpo"), fakeFetch(200, '{"message":"Post created."}')),
      /não confirmada/,
    );
  });

  it("publishCircleStackCycle grava post_id e post_slug além de post_url", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "stack-13104-")), "circle-stack-published.json");
    const payload = buildStackPostPayload("T", "Corpo");
    await publishCircleStackCycle({
      statePath,
      cycle: "26w46",
      title: "T",
      payload,
      force: false,
      send: (p) => sendStackPost("https://hook.test", "k", p, fakeFetch(200, JSON.stringify(CIRCLE_RESPONSE))),
    });
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.post_url, "https://plataforma.stack.com.br/c/radar/radar-26w46");
    assert.equal(state.post_id, 987654);
    assert.equal(state.post_slug, "radar-26w46");
    assert.ok(state.published_at);
  });

  it("formato n8n: state sem post_id/post_slug", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "stack-13104-")), "circle-stack-published.json");
    await publishCircleStackCycle({
      statePath,
      cycle: "26w46",
      title: "T",
      payload: buildStackPostPayload("T", "Corpo"),
      force: false,
      send: (p) => sendStackPost("https://hook.test", "k", p, fakeFetch(200, '{"ok": true}')),
    });
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal("post_id" in state, false);
    assert.equal("post_slug" in state, false);
  });
});
