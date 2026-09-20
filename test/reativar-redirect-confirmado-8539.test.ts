/**
 * test/reativar-redirect-confirmado-8539.test.ts (#8539)
 *
 * Substitui `test/reativar-kit-recommendations-widget-7524.test.ts`, que
 * cobria a tela de confirmação inline deste worker — tela que deixou de
 * existir quando o sucesso passou a redirecionar.
 *
 * ## O que esta mudança resolve
 *
 * Antes do #8539 havia dois caminhos de confirmação terminando em páginas
 * diferentes: o e-mail do Kit levava a `diar.ia.br/confirmado` (que carrega
 * o GTM via `renderAnalyticsHead`), e o botão do e-mail da Brevo terminava
 * numa página HTML servida pelo próprio worker, sem tag nenhuma. Qualquer
 * conversão ancorada na página de confirmação só via o primeiro grupo.
 *
 * ## O invariante que NÃO pode quebrar
 *
 * **Só o ramo `active` redireciona.** `renderConfirmacaoEnviadaPage`
 * (`inactive` — o desfecho NORMAL do clique com DOI ligado, #7723) e
 * `renderNotConfirmedPage` (#4476: 2xx sem ativação real) continuam com
 * página própria. Redirecionar qualquer um dos dois dispararia a conversão
 * sem confirmação — o único erro deste fluxo que não dá pra corrigir depois,
 * porque a plataforma de anúncio já teria contado.
 *
 * ## Sobre o widget do #7524 removido junto
 *
 * `KIT_RECOMMENDATIONS_EMBED_URL` era o lado outgoing do Kit Creator Network,
 * embutido só naquela tela. Nunca foi configurado em produção (`wrangler
 * secret list` em 20/09/2026 não o listava) e a própria #7524 registrou a URL
 * de embed como NÃO CONFIRMADA, então remover não mudou nada que rodava. Ver
 * #8561 pra re-hospedar o widget na página nova.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleConfirm, CONFIRMADO_REDIRECT_URL, renderNotConfirmedPage, type Env } from "../workers/reativar/src/index.ts";
import { PAGE_URL, VIA_BREVO, renderConfirmadoPage, handleConfirmadoPage } from "../scripts/lib/shared/confirmado-page.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routedFetch(handlers: {
  get?: () => Response | Promise<Response>;
  post?: (body: unknown) => Response | Promise<Response>;
}): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST") return handlers.post ? handlers.post(init?.body) : jsonRes(200, {});
    return handlers.get ? handlers.get() : jsonRes(200, { subscribers: [] });
  }) as typeof fetch;
}

const KIT_ENV: Env = {
  SUBSCRIBE_BACKEND: "kit",
  KIT_API_KEY: "test-kit-key",
  KIT_API_URL: "https://kit.test/v4",
};

describe("#8539 — destino do redirect", () => {
  it("deriva de PAGE_URL, nunca de uma string literal (senão o rename da #8554 quebra este worker)", () => {
    assert.ok(CONFIRMADO_REDIRECT_URL.startsWith(`${PAGE_URL}?`));
    assert.equal(new URL(CONFIRMADO_REDIRECT_URL).searchParams.get("via"), VIA_BREVO);
  });

  it("o código-fonte do worker não contém a URL de confirmação escrita à mão", () => {
    const src = readFileSync(new URL("../workers/reativar/src/index.ts", import.meta.url), "utf8");
    assert.ok(!src.includes('"https://diar.ia.br/confirmado'), "use PAGE_URL de confirmado-page.ts, não um literal");
  });
});

describe("#8539 — só a confirmação REAL redireciona", () => {
  it('Kit: assinante vira "active" → 303 pra /confirmada?via=brevo (#8554)', async () => {
    const fetchImpl = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(201, { subscriber: { state: "active" } }),
    });
    const res = await handleConfirm(new URL("https://reativar.test/?email=a@b.com"), KIT_ENV, fetchImpl);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), CONFIRMADO_REDIRECT_URL);
  });

  it("Beehiiv: mesma resposta — o destino não depende do backend", async () => {
    const fetchImpl = routedFetch({
      get: () => jsonRes(404, {}),
      post: () => jsonRes(201, { data: { status: "active" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "bk", BEEHIIV_PUBLICATION_ID: "pub" };
    const res = await handleConfirm(new URL("https://reativar.test/?email=a@b.com"), env, fetchImpl);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), CONFIRMADO_REDIRECT_URL);
  });

  it("o redirect NUNCA pode ser cacheado — clique seguinte tem que reentrar no worker", async () => {
    const fetchImpl = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(201, { subscriber: { state: "active" } }),
    });
    const res = await handleConfirm(new URL("https://reativar.test/?email=a@b.com"), KIT_ENV, fetchImpl);
    assert.match(res.headers.get("Cache-Control") ?? "", /no-store/);
  });

  it('DOI pendente ("inactive", #7723) → 200 HTML, NUNCA redirect — a pessoa ainda não confirmou', async () => {
    // `KIT_DOI_FORM_ID` num designer form válido é o que faz o cadastro
    // nascer `inactive` (`resolveKitCreateState`) — sem ele o worker cria
    // direto como `active` e este caso nem existe.
    const fetchImpl = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(201, { subscriber: { id: 42, state: "inactive" } }),
    });
    const env: Env = { ...KIT_ENV, KIT_DOI_FORM_ID: "9897918" };
    const res = await handleConfirm(new URL("https://reativar.test/?email=a@b.com"), env, fetchImpl);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Location"), null);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/html/);
  });

  it('2xx sem ativação real ("invalid", #4476) → 200 HTML "ainda não confirmado", NUNCA redirect', async () => {
    const fetchImpl = routedFetch({
      get: () => jsonRes(404, {}),
      post: () => jsonRes(201, { data: { status: "invalid" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "bk", BEEHIIV_PUBLICATION_ID: "pub" };
    const res = await handleConfirm(new URL("https://reativar.test/?email=a@b.com"), env, fetchImpl);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Location"), null);
    assert.equal(await res.text(), renderNotConfirmedPage());
  });

  it("e-mail ausente → 200 HTML, NUNCA redirect", async () => {
    const res = await handleConfirm(new URL("https://reativar.test/"), KIT_ENV);
    assert.equal(res.headers.get("Location"), null);
  });

  it("secrets ausentes → 503, NUNCA redirect", async () => {
    const res = await handleConfirm(new URL("https://reativar.test/?email=a@b.com"), {});
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Location"), null);
  });

  // Achado do review desta PR (silent-failure-hunter, P1). `beehiivStatus:
  // "active"` sozinho não prova que ESTE clique confirmou: cobre também quem
  // já estava ativo. Enquanto o sucesso era HTML sem tag isso era inócuo;
  // com o redirect, contaria conversão por confirmação que não houve.
  for (const [nome, env, fetchImpl] of [
    [
      "Kit",
      { ...KIT_ENV },
      routedFetch({
        get: () => jsonRes(200, { subscribers: [{ id: 7, state: "active", email_address: "a@b.com" }] }),
        post: () => {
          throw new Error("não deveria criar/atualizar quem já está active");
        },
      }),
    ],
    [
      "Beehiiv",
      { BEEHIIV_API_KEY: "bk", BEEHIIV_PUBLICATION_ID: "pub" },
      routedFetch({
        get: () => jsonRes(200, { data: { id: "s1", status: "active" } }),
        post: () => {
          throw new Error("não deveria criar/atualizar quem já está active");
        },
      }),
    ],
  ] as [string, Env, typeof fetch][]) {
    it(`${nome}: assinante JÁ estava active → 200 HTML, NUNCA redirect (este clique não confirmou nada)`, async () => {
      const res = await handleConfirm(new URL("https://reativar.test/?email=a@b.com"), env, fetchImpl);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Location"), null, "clique repetido não pode contar conversão");
      assert.match(await res.text(), /já estava confirmada/i);
    });
  }

  // Estados terminais: o clique no botão nunca ressuscita quem saiu (#8194/
  // #8269), e por isso também nunca pode contar conversão.
  for (const terminal of ["cancelled", "complained", "bounced"]) {
    it(`Kit: estado terminal "${terminal}" → NUNCA redirect`, async () => {
      const fetchImpl = routedFetch({
        get: () => jsonRes(200, { subscribers: [{ id: 9, state: terminal, email_address: "a@b.com" }] }),
        post: () => {
          throw new Error(`não deveria tocar quem está ${terminal}`);
        },
      });
      const res = await handleConfirm(new URL("https://reativar.test/?email=a@b.com"), KIT_ENV, fetchImpl);
      assert.equal(res.headers.get("Location"), null);
      assert.notEqual(res.status, 303);
    });
  }
});

describe("#8539 — copy da página de destino varia com ?via=", () => {
  it("sem via: promete a PRIMEIRA edição (o público do e-mail do Kit ainda não recebe)", () => {
    const html = renderConfirmadoPage();
    assert.ok(html.includes("Sua primeira edição chega"));
    assert.ok(!html.includes("A diária continua chegando"));
  });

  it("via=brevo: NÃO promete primeira edição — esse público já recebe a diária pela Brevo", () => {
    const html = renderConfirmadoPage(VIA_BREVO);
    assert.ok(html.includes("A diária continua chegando"));
    assert.ok(!html.includes("Sua primeira edição chega"));
  });

  it("via desconhecido cai no texto padrão, nunca em erro", () => {
    assert.equal(renderConfirmadoPage("qualquer-coisa"), renderConfirmadoPage());
  });

  it("as duas variantes continuam carregando o GTM — é o ponto do redirect", () => {
    for (const html of [renderConfirmadoPage(), renderConfirmadoPage(VIA_BREVO)]) {
      assert.ok(html.includes("googletagmanager.com"), "sem GTM a conversão não é medida em nenhum dos caminhos");
    }
  });

  it("handleConfirmadoPage repassa o via adiante", async () => {
    const res = handleConfirmadoPage(VIA_BREVO);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("A diária continua chegando"));
  });
});

describe("#8539 — widget do #7524 removido junto com a tela", () => {
  it("o worker não referencia mais KIT_RECOMMENDATIONS_EMBED_URL no código", () => {
    const src = readFileSync(new URL("../workers/reativar/src/index.ts", import.meta.url), "utf8");
    assert.ok(!src.includes("KIT_RECOMMENDATIONS_EMBED_URL"));
    assert.ok(!src.includes("renderSuccessPage"));
  });

  it("poll/cursos seguem API pura — nunca tiveram onde embutir o widget (#7524)", () => {
    for (const rel of ["../workers/poll/src/subscribe.ts", "../workers/cursos/src/subscribe.ts"]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      assert.ok(!src.includes("KIT_RECOMMENDATIONS_EMBED_URL"), `${rel} é API pura — o embed não se aplica`);
    }
  });
});
