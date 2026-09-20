/**
 * test/reativar-kit-recommendations-widget-7524.test.ts (#7524, escopo
 * reduzido no #8539)
 *
 * Dos 3 workers de cadastro (`poll`, `cursos`, `reativar`), só `reativar`
 * renderizava uma tela de confirmação servida por navegação de página
 * inteira (`GET /?email=X` → `renderSuccessPage`) — `poll`
 * (`POST /jogar/subscribe`) e `cursos` (`POST /gate/subscribe`) são API pura
 * consumida por JS inline (mensagem de status + reset do form, nunca uma
 * tela própria), então o widget não tem onde embutir nesses dois.
 *
 * **#8539: `renderSuccessPage` foi removida.** O clique confirmado do
 * `reativar` passou a REDIRECIONAR (303) pra `/confirmada`
 * (`scripts/lib/shared/confirmado-page.ts`, Worker `site`) em vez de
 * renderizar sua própria tela — o widget (`renderKitRecommendationsBlock`)
 * moveu junto, pro destino do redirect. Cobertura do widget em si:
 * `test/confirmado-page-shared-7737.test.ts` (descrição "widget Kit Creator
 * Network opcional"). Este arquivo mantém só o que ainda é verdade:
 *
 *   1. `handleConfirm` (reativar) nunca embute HTML/widget na própria
 *      resposta — ela é sempre um redirect vazio no caminho de sucesso,
 *      independente de `KIT_RECOMMENDATIONS_EMBED_URL` estar setado no Env
 *      do `reativar` (que nem existe mais lá — ver `workers/site/src/index.ts`
 *      pro Env que passou a carregar essa var).
 *   2. `poll`/`cursos` continuam API pura, sem nenhuma referência ao embed
 *      (regressão inalterada pelo #8539).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleConfirm, type Env } from "../workers/reativar/src/index.ts";
import { PAGE_URL as CONFIRMADA_PAGE_URL } from "../scripts/lib/shared/confirmado-page.ts";

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

describe("handleConfirm (reativar) — sucesso é SEMPRE um redirect vazio, nunca HTML/widget (#8539)", () => {
  it('backend "kit" → 303 pra /confirmada, corpo vazio, sem iframe (widget não existe mais na resposta do reativar)', async () => {
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
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), `${CONFIRMADA_PAGE_URL}?via=brevo`);
    const body = await res.text();
    assert.equal(body, "", "redirect não carrega corpo — o widget mora no destino, não aqui");
  });

  it('backend Beehiiv (default) → mesmo redirect, sem depender de nenhuma var "KIT_*"', async () => {
    const fetchImpl = routedFetch({
      get: () => jsonRes(404, {}),
      post: () => jsonRes(201, { data: { status: "active" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "bk", BEEHIIV_PUBLICATION_ID: "pub" };
    const url = new URL("https://reativar.test/?email=a@b.com");
    const res = await handleConfirm(url, env, fetchImpl);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), `${CONFIRMADA_PAGE_URL}?via=brevo`);
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

  it("workers/reativar/src/index.ts não carrega mais KIT_RECOMMENDATIONS_EMBED_URL (movido pro Worker site no #8539)", () => {
    const src = readFileSync(new URL("../workers/reativar/src/index.ts", import.meta.url), "utf8");
    assert.ok(
      !/KIT_RECOMMENDATIONS_EMBED_URL\??:\s*string/.test(src),
      "o campo do Env foi removido — a var agora vive só no Env do Worker site",
    );
  });
});
