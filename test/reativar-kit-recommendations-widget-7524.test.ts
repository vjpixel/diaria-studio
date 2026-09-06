/**
 * test/reativar-kit-recommendations-widget-7524.test.ts (#7524)
 *
 * Lado OUTGOING do Kit Creator Network — follow-up do #6674. Dos 3 workers
 * de cadastro (`poll`, `cursos`, `reativar`), só `reativar` de fato renderiza
 * uma tela de confirmação servida por navegação de página inteira
 * (`GET /?email=X` → `renderSuccessPage`) — `poll` (`POST /jogar/subscribe`)
 * e `cursos` (`POST /gate/subscribe`) são API pura consumida por JS inline
 * (mensagem de status + reset do form, nunca uma tela própria), então o
 * widget não tem onde embutir nesses dois. Este teste cobre:
 *
 *   1. `renderSuccessPage` embute o `<iframe>` do widget quando `embedUrl`
 *      é passado, e NÃO embute quando omitido (regressão do comportamento
 *      pré-#7524, já coberto por `test/reativar-worker-4476.test.ts` — este
 *      teste garante que o novo parâmetro opcional não quebra esse
 *      contrato).
 *   2. `handleConfirm` só passa `KIT_RECOMMENDATIONS_EMBED_URL` adiante
 *      quando `useKit` (backend Kit) — no caminho Beehiiv o widget nunca
 *      aparece, mesmo que a var esteja setada (ela é específica do Creator
 *      Network da Kit).
 *   3. Confirma por leitura direta do código-fonte que `poll`/`cursos` não
 *      ganharam nenhuma referência ao widget — eles são API pura, o embed
 *      não se aplica (ver docstring do módulo `workers/reativar/src/index.ts`,
 *      campo `KIT_RECOMMENDATIONS_EMBED_URL`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  renderSuccessPage,
  handleConfirm,
  type Env,
} from "../workers/reativar/src/index.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routedFetch(handlers: {
  get?: () => Response | Promise<Response>;
  post?: (body: unknown) => Response | Promise<Response>;
}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST") return handlers.post ? handlers.post(init?.body) : jsonRes(200, {});
    return handlers.get ? handlers.get() : jsonRes(200, { subscribers: [] });
  }) as typeof fetch;
}

const KIT_EMBED_URL = "https://diariabr.kit.com/profile/recommendations";

describe("renderSuccessPage — widget Kit Creator Network opcional (#7524)", () => {
  it("sem embedUrl (default): página idêntica ao comportamento pré-#7524, sem iframe", () => {
    const html = renderSuccessPage();
    assert.ok(!html.includes("<iframe"), "não deveria ter iframe sem embedUrl");
    assert.ok(html.includes("Cadastro confirmado!"));
  });

  it("com embedUrl: embute o iframe do widget apontando pra URL configurada", () => {
    const html = renderSuccessPage(KIT_EMBED_URL);
    assert.ok(html.includes("<iframe"), "deveria ter iframe com embedUrl");
    assert.ok(html.includes(KIT_EMBED_URL), "iframe deveria apontar pra URL configurada");
    assert.ok(html.includes("Cadastro confirmado!"), "copy de sucesso preservada");
  });
});

describe("handleConfirm — widget só aparece no caminho Kit (#7524)", () => {
  it('backend "kit" + KIT_RECOMMENDATIONS_EMBED_URL setado → widget presente na resposta', async () => {
    const fetchImpl = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(201, { subscriber: { state: "active" } }),
    });
    const env: Env = {
      SUBSCRIBE_BACKEND: "kit",
      KIT_API_KEY: "test-kit-key",
      KIT_API_URL: "https://kit.test/v4",
      KIT_RECOMMENDATIONS_EMBED_URL: KIT_EMBED_URL,
    };
    const url = new URL("https://reativar.test/?email=a@b.com");
    const res = await handleConfirm(url, env, fetchImpl);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("<iframe"), "widget deveria aparecer no caminho Kit com a var setada");
    assert.ok(html.includes(KIT_EMBED_URL));
  });

  it('backend "kit" sem KIT_RECOMMENDATIONS_EMBED_URL (default) → sem widget, comportamento pré-#7524', async () => {
    const fetchImpl = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(201, { subscriber: { state: "active" } }),
    });
    const env: Env = {
      SUBSCRIBE_BACKEND: "kit",
      KIT_API_KEY: "test-kit-key",
      KIT_API_URL: "https://kit.test/v4",
    };
    const url = new URL("https://reativar.test/?email=a@b.com");
    const res = await handleConfirm(url, env, fetchImpl);
    const html = await res.text();
    assert.ok(!html.includes("<iframe"));
  });

  it('backend Beehiiv (default) + KIT_RECOMMENDATIONS_EMBED_URL setado por engano → widget NUNCA aparece (é específico do Kit)', async () => {
    const fetchImpl = routedFetch({
      get: () => jsonRes(404, {}),
      post: () => jsonRes(201, { data: { status: "active" } }),
    });
    const env: Env = {
      BEEHIIV_API_KEY: "bk",
      BEEHIIV_PUBLICATION_ID: "pub",
      KIT_RECOMMENDATIONS_EMBED_URL: KIT_EMBED_URL,
    };
    const url = new URL("https://reativar.test/?email=a@b.com");
    const res = await handleConfirm(url, env, fetchImpl);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes("<iframe"), "widget é específico do Creator Network Kit — não deveria vazar pro caminho Beehiiv");
  });
});

describe("poll/cursos permanecem API pura — sem superfície pra embutir o widget (#7524)", () => {
  it("workers/poll/src/subscribe.ts continua respondendo só JSON em handleJogarSubscribe (sem referência ao embed)", () => {
    const src = readFileSync(new URL("../workers/poll/src/subscribe.ts", import.meta.url), "utf8");
    assert.ok(!src.includes("KIT_RECOMMENDATIONS_EMBED_URL"), "poll é API pura — o embed não se aplica aqui (ver #7524)");
  });

  it("workers/cursos/src/subscribe.ts continua respondendo só JSON (sem referência ao embed)", () => {
    const src = readFileSync(new URL("../workers/cursos/src/subscribe.ts", import.meta.url), "utf8");
    assert.ok(!src.includes("KIT_RECOMMENDATIONS_EMBED_URL"), "cursos é API pura — o embed não se aplica aqui (ver #7524)");
  });
});
