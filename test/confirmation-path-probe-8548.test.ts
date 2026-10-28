/**
 * #8548 item 4 — sonda do caminho pós-confirmação (Kit → /confirmada e botão
 * da Brevo → /confirmada?via=brevo), sobre respostas HTTP simuladas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIRMATION_PATH_PROBES,
  MAX_REDIRECT_HOPS,
  evaluateConfirmationProbe,
  fetchConfirmationProbe,
  type ConfirmationProbe,
} from "../scripts/lib/confirmation-path-probe.ts";
import { renderConfirmadoPage } from "../scripts/lib/shared/confirmado-page.ts";
import { runConfirmationPathProbe } from "../scripts/confirmation-path-probe.ts";

const probe = (id: string): ConfirmationProbe => CONFIRMATION_PATH_PROBES.find((p) => p.id === id)!;

/** `fetch` falso que serve o mapa de rotas, só pelo href exato. */
function fakeFetch(routes: Record<string, { status: number; location?: string; body?: string; contentType?: string }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.method, "GET");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const r = routes[url];
    if (!r) throw new Error(`rota não simulada: ${url}`);
    const headers = new Headers();
    if (r.location) headers.set("location", r.location);
    headers.set("content-type", r.contentType ?? "text/html;charset=utf-8");
    return new Response(r.status >= 300 && r.status < 400 ? null : (r.body ?? ""), { status: r.status, headers });
  }) as typeof fetch;
}

const PAGINA_KIT = renderConfirmadoPage();
const PAGINA_BREVO = renderConfirmadoPage("brevo");

describe("evaluateConfirmationProbe (#8548 item 4)", () => {
  it("cadeia legada 301 → /confirmada com a página do repo passa", async () => {
    const res = await fetchConfirmationProbe(
      probe("kit-redirect-legado"),
      fakeFetch({
        "https://eia.diar.ia.br/confirmado": { status: 301, location: "https://diar.ia.br/confirmada" },
        "https://diar.ia.br/confirmada": { status: 200, body: PAGINA_KIT },
      }),
    );
    const v = evaluateConfirmationProbe(probe("kit-redirect-legado"), res);
    assert.deepEqual(v.problemas, []);
    assert.equal(v.ok, true);
    assert.equal(v.saltos, 1);
  });

  it("?via=brevo precisa chegar à página e trazer a linha de entrega da Brevo", async () => {
    const ok = evaluateConfirmationProbe(
      probe("brevo-destino"),
      await fetchConfirmationProbe(
        probe("brevo-destino"),
        fakeFetch({ "https://diar.ia.br/confirmada?via=brevo": { status: 200, body: PAGINA_BREVO } }),
      ),
    );
    assert.equal(ok.ok, true);
    // worker defasado: serve a variante padrão mesmo com ?via=brevo
    const defasado = evaluateConfirmationProbe(
      probe("brevo-destino"),
      await fetchConfirmationProbe(
        probe("brevo-destino"),
        fakeFetch({ "https://diar.ia.br/confirmada?via=brevo": { status: 200, body: PAGINA_KIT } }),
      ),
    );
    assert.equal(defasado.ok, false);
    assert.match(defasado.problemas.join("\n"), /linha de entrega da variante brevo/);
  });

  it("redirect que perde a query string é problema", async () => {
    const p: ConfirmationProbe = { id: "x", url: "https://diar.ia.br/confirmado?via=brevo", via: "brevo", descricao: "" };
    const v = evaluateConfirmationProbe(
      p,
      await fetchConfirmationProbe(
        p,
        fakeFetch({
          "https://diar.ia.br/confirmado?via=brevo": { status: 301, location: "/confirmada" },
          "https://diar.ia.br/confirmada": { status: 200, body: PAGINA_KIT },
        }),
      ),
    );
    assert.equal(v.ok, false);
    assert.match(v.problemas.join("\n"), /\?via= chegou como ausente/);
  });

  it("404 no destino e página sem GTM são problemas", async () => {
    const v404 = evaluateConfirmationProbe(
      probe("kit-destino"),
      await fetchConfirmationProbe(probe("kit-destino"), fakeFetch({ "https://diar.ia.br/confirmada": { status: 404, body: "nope" } })),
    );
    assert.match(v404.problemas.join("\n"), /status final 404/);
    const semGtm = PAGINA_KIT.replace(/GTM-[A-Z0-9]+/g, "GTM-REMOVIDO");
    const vGtm = evaluateConfirmationProbe(
      probe("kit-destino"),
      await fetchConfirmationProbe(probe("kit-destino"), fakeFetch({ "https://diar.ia.br/confirmada": { status: 200, body: semGtm } })),
    );
    assert.match(vGtm.problemas.join("\n"), /container GTM-/);
  });

  it("redirect para fora de /confirmada (ex.: default do Kit) é problema", async () => {
    const p: ConfirmationProbe = { id: "y", url: "https://eia.diar.ia.br/confirmado", descricao: "" };
    const v = evaluateConfirmationProbe(
      p,
      await fetchConfirmationProbe(
        p,
        fakeFetch({
          "https://eia.diar.ia.br/confirmado": { status: 302, location: "https://app.kit.com/confirm-subscription" },
          "https://app.kit.com/confirm-subscription": { status: 200, body: "<h1>Kit</h1>" },
        }),
      ),
    );
    assert.match(v.problemas.join("\n"), /terminou em app\.kit\.com\/confirm-subscription/);
  });

  it("loop de redirect para em MAX_REDIRECT_HOPS e vira problema", async () => {
    const p: ConfirmationProbe = { id: "loop", url: "https://diar.ia.br/a", descricao: "" };
    const res = await fetchConfirmationProbe(
      p,
      fakeFetch({
        "https://diar.ia.br/a": { status: 301, location: "https://diar.ia.br/b" },
        "https://diar.ia.br/b": { status: 301, location: "https://diar.ia.br/a" },
      }),
    );
    assert.equal(res.hops.length, MAX_REDIRECT_HOPS + 1);
    const v = evaluateConfirmationProbe(p, res);
    assert.equal(v.ok, false);
    assert.match(v.problemas.join("\n"), /mais de 5 redirects/);
  });

  it("erro de rede vira problema, nunca lança", async () => {
    const res = await fetchConfirmationProbe(probe("kit-destino"), (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch);
    const v = evaluateConfirmationProbe(probe("kit-destino"), res);
    assert.equal(v.ok, false);
    assert.match(v.problemas.join("\n"), /ECONNRESET/);
  });
});

describe("runConfirmationPathProbe", () => {
  it("roda as 4 sondas contra o comportamento do worker site (301 + página do repo)", async () => {
    const verdicts = await runConfirmationPathProbe(
      fakeFetch({
        "https://eia.diar.ia.br/confirmado": { status: 301, location: "https://diar.ia.br/confirmada" },
        "https://diar.ia.br/confirmado": { status: 301, location: "https://diar.ia.br/confirmada" },
        "https://diar.ia.br/confirmada": { status: 200, body: PAGINA_KIT },
        "https://diar.ia.br/confirmada?via=brevo": { status: 200, body: PAGINA_BREVO },
      }),
    );
    assert.deepEqual(verdicts.map((v) => [v.id, v.ok]), [
      ["kit-redirect-legado", true],
      ["apex-legado", true],
      ["kit-destino", true],
      ["brevo-destino", true],
    ]);
  });
});
