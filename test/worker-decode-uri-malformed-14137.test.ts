/**
 * test/worker-decode-uri-malformed-14137.test.ts (#14137)
 *
 * `decodeURIComponent` lança `URIError` em `%` malformado (`/%`, `/%zz`,
 * UTF-8 truncado como `/%E0%A4%A` — link cortado ao colar). Nos Workers que
 * decodificavam o path sem try, isso virava 500/1101 e exceção no log.
 *
 * Regressão por Worker:
 *   - draft: GET e PUT com key malformada → 400 "invalid key" (sem eco do
 *     input); path normal segue como antes (200 / 404 / 401).
 *   - linkedin-cron: DELETE /dlq/:key, DELETE /queue/:key e
 *     POST /queue-cancel/:key malformados → 400; key normal sem token segue 401.
 *   - poll: /og, /quiz-og → 404 e /share, /quiz-share → 302, igual a token
 *     inválido; token válido segue servindo.
 *   - retrospectiva: redirect legado com slug malformado → raiz com a query,
 *     igual a slug intraduzível; slug válido segue traduzindo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import draftWorker, { handleGet, handlePut } from "../workers/draft/src/index.ts";
import {
  handleOgImage,
  handleSharePage,
  handleQuizOgImage,
  handleQuizSharePage,
} from "../workers/poll/src/index.ts";
import { encodeShareToken } from "../workers/poll/src/share.ts";
import { legacyRedirectPath } from "../workers/retrospectiva/src/index.ts";

const MALFORMED = ["/%", "/%zz", "/%E0%A4%A"];

// linkedin-cron entra por import dinâmico com caminho não-literal: um import
// estático puxaria `workers/linkedin-cron/src` para o programa de
// `tsconfig.test.json`, que não carrega `@cloudflare/workers-types`
// (`ScheduledEvent` não resolve → erro novo no ratchet). E como
// `workers/linkedin-cron/package.json` não declara `"type": "module"`, da raiz
// o módulo chega pelo interop CJS, com o `export default` em `.default.default`.
type LinkedinWorker = { fetch(request: Request, env: unknown): Promise<Response> };
const linkedinMod = (await import(
  new URL("../workers/linkedin-cron/src/index.ts", import.meta.url).href
)) as { default: LinkedinWorker | { default: LinkedinWorker } };
const linkedinWorker: LinkedinWorker =
  "fetch" in linkedinMod.default ? linkedinMod.default : linkedinMod.default.default;

// ── draft ─────────────────────────────────────────────────────────────────────

function makeDraftEnv(kv: Map<string, string> = new Map()) {
  return {
    DRAFT: {
      async get(key: string): Promise<string | null> {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string): Promise<void> {
        kv.set(key, value);
      },
    },
    ADMIN_SECRET: "test-secret",
  } as unknown as Parameters<typeof handleGet>[1];
}

describe("#14137 draft — % malformado vira 400, não 500", () => {
  for (const path of MALFORMED) {
    it(`GET ${path} → 400 sem eco do input`, async () => {
      const res = await handleGet(path, makeDraftEnv());
      assert.equal(res.status, 400);
      const body = await res.text();
      assert.equal(body, "invalid key");
    });

    it(`PUT ${path} → 400 JSON, antes da auth`, async () => {
      const req = new Request(`https://draft.test${path}`, { method: "PUT", body: "<p>x</p>" });
      const res = await handlePut(path, req, makeDraftEnv());
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "invalid key" });
    });
  }

  it("fetch completo com URL malformada também devolve 400 (sem exceção)", async () => {
    const res = await draftWorker.fetch(new Request("https://draft.test/%E0%A4%A"), makeDraftEnv());
    assert.equal(res.status, 400);
  });

  it("path normal segue como antes: key presente → 200, ausente → 404, raiz → 404", async () => {
    const kv = new Map([["html:260518", "<p>ok</p>"]]);
    const hit = await handleGet("/260518", makeDraftEnv(kv));
    assert.equal(hit.status, 200);
    assert.equal(await hit.text(), "<p>ok</p>");
    assert.equal((await handleGet("/260519", makeDraftEnv(kv))).status, 404);
    assert.equal((await handleGet("/", makeDraftEnv(kv))).status, 404);
  });

  it("key com %-escape VÁLIDO segue decodificada (ç)", async () => {
    const kv = new Map([["html:edição", "<p>ç</p>"]]);
    const res = await handleGet(`/${encodeURIComponent("edição")}`, makeDraftEnv(kv));
    assert.equal(res.status, 200);
  });

  it("PUT com key normal sem token segue 401", async () => {
    const req = new Request("https://draft.test/260518", { method: "PUT", body: "<p>x</p>" });
    const res = await handlePut("/260518", req, makeDraftEnv());
    assert.equal(res.status, 401);
  });
});

// ── linkedin-cron ─────────────────────────────────────────────────────────────

describe("#14137 linkedin-cron — rotas com :key malformada viram 400", () => {
  const env = { DIARIA_TOKEN: "real-token" };
  const routes: Array<[string, string]> = [
    ["DELETE", "/dlq/"],
    ["DELETE", "/queue/"],
    ["POST", "/queue-cancel/"],
  ];
  for (const [method, prefix] of routes) {
    for (const bad of ["%", "%zz", "%E0%A4%A"]) {
      it(`${method} ${prefix}${bad} → 400`, async () => {
        const res = await linkedinWorker.fetch(
          new Request(`https://w.test${prefix}${bad}`, { method }),
          env,
        );
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "invalid key" });
      });
    }
    it(`${method} ${prefix}{key normal} sem token segue 401`, async () => {
      const res = await linkedinWorker.fetch(
        new Request(`https://w.test${prefix}dlq:abc`, { method }),
        env,
      );
      assert.equal(res.status, 401);
    });
  }
});

// ── poll ──────────────────────────────────────────────────────────────────────

describe("#14137 poll — token malformado é tratado como token inválido", () => {
  const env = { POLL_SECRET: "poll-secret" } as unknown as Parameters<typeof handleOgImage>[1];
  const url = new URL("https://poll.test/");

  for (const bad of ["%", "%zz", "%E0%A4%A"]) {
    it(`/og/${bad} e /quiz-og/${bad} → 404`, async () => {
      assert.equal((await handleOgImage(`/og/${bad}`, env)).status, 404);
      assert.equal((await handleQuizOgImage(`/quiz-og/${bad}`, env)).status, 404);
    });
    it(`/share/${bad} → 302 /jogar e /quiz-share/${bad} → 302 /jogar/quiz`, async () => {
      const share = await handleSharePage(url, `/share/${bad}`, env);
      assert.equal(share.status, 302);
      assert.equal(share.headers.get("Location"), "/jogar");
      const quiz = await handleQuizSharePage(url, `/quiz-share/${bad}`, env);
      assert.equal(quiz.status, 302);
      assert.equal(quiz.headers.get("Location"), "/jogar/quiz");
    });
  }

  it("token válido segue servindo a imagem e a página", async () => {
    const token = await encodeShareToken("poll-secret", { edition: "260518", correct: true });
    const og = await handleOgImage(`/og/${encodeURIComponent(token)}`, env);
    assert.equal(og.status, 200);
    const page = await handleSharePage(url, `/share/${encodeURIComponent(token)}`, env);
    assert.equal(page.status, 200);
  });
});

// ── retrospectiva ─────────────────────────────────────────────────────────────

describe("#14137 retrospectiva — slug legado malformado não lança", () => {
  for (const bad of MALFORMED) {
    it(`anual ${bad} → raiz com a query (sem URIError)`, () => {
      assert.equal(legacyRedirectPath("anual.diar.ia.br", bad, "?utm_source=kit"), "/?utm_source=kit");
      assert.equal(legacyRedirectPath("artigo.diar.ia.br", bad, ""), null);
    });
  }

  it("slug válido segue traduzindo", () => {
    assert.equal(legacyRedirectPath("anual.diar.ia.br", "/2026-aniversario", ""), "/aniversario2026");
  });
});
