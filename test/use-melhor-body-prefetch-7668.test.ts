/**
 * #7668 — cobertura DIRETA das três peças novas do fix (review da PR #7735,
 * P2): `fetchBodyForCache`, `prefetchUseMelhorBodies` e o invariant
 * `checkUseMelhorTempoTitleHeuristicShare`. Os 2 testes originais da PR
 * exercitavam só `estimateUseMelhorTempoDetailed` contra cache pré-populado
 * — o GET de rede, o fail-soft, o "não refetch o que já está cacheado" e o
 * check de Stage 4 ficavam sem rede alguma.
 *
 * `fetch` é substituído por um stub em `globalThis` (restaurado no `after`)
 * — nunca rede real: o que se testa é o CONTRATO fail-soft, não um site.
 */

import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchBodyForCache, prefetchUseMelhorBodies } from "../scripts/stitch-newsletter.ts";
import { loadCachedBody, saveCachedBody, bodyCachePath } from "../scripts/lib/url-body-cache.ts";
import { checkUseMelhorTempoTitleHeuristicShare } from "../scripts/lib/invariant-checks/stage-4.ts";

const realFetch = globalThis.fetch;
const roots: string[] = [];
after(() => {
  globalThis.fetch = realFetch;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

/** Stub de fetch: devolve o que `handler` mandar e conta as chamadas. */
function stubFetch(handler: (url: string) => { ok: boolean; body: string } | Error) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    calls.push(url);
    const r = handler(url);
    if (r instanceof Error) throw r;
    return { ok: r.ok, text: async () => r.body } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

const LONG = "x".repeat(600); // > 500 chars, o piso de "body de verdade"

describe("#7668 fetchBodyForCache — GET sob demanda, fail-soft, grava no cache", () => {
  it("resposta ok com body >= 500 chars → devolve o body E persiste no cache (execuções seguintes reutilizam)", async () => {
    const dir = tmp("prefetch-ok-");
    stubFetch(() => ({ ok: true, body: LONG }));
    const url = "https://exemplo.test/artigo-longo";
    const body = await fetchBodyForCache(dir, url);
    assert.equal(body, LONG);
    assert.ok(existsSync(bodyCachePath(dir, url)), "o body precisa estar em disco pro estimateFor síncrono ler depois");
    assert.equal(loadCachedBody(dir, url), LONG);
  });

  it("resposta !ok → null, nada gravado (não cacheia página de erro)", async () => {
    const dir = tmp("prefetch-404-");
    stubFetch(() => ({ ok: false, body: LONG }));
    const url = "https://exemplo.test/404";
    assert.equal(await fetchBodyForCache(dir, url), null);
    assert.equal(existsSync(bodyCachePath(dir, url)), false);
  });

  it("body < 500 chars → null, nada gravado (stub/redirect/consent wall não vira estimativa)", async () => {
    const dir = tmp("prefetch-curto-");
    stubFetch(() => ({ ok: true, body: "curto demais" }));
    const url = "https://exemplo.test/curto";
    assert.equal(await fetchBodyForCache(dir, url), null);
    assert.equal(existsSync(bodyCachePath(dir, url)), false);
  });

  it("fetch lança (rede fora, timeout/abort) → null, nunca propaga — o stitch segue com a heurística de título", async () => {
    const dir = tmp("prefetch-erro-");
    stubFetch(() => new Error("ECONNRESET"));
    await assert.doesNotReject(async () => {
      assert.equal(await fetchBodyForCache(dir, "https://exemplo.test/fora"), null);
    });
  });
});

describe("#7668 prefetchUseMelhorBodies — só busca o que falta", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp("prefetch-lote-");
  });

  it("item já cacheado NÃO gera fetch; item sem cache gera exatamente 1; item sem url é ignorado", async () => {
    const cached = "https://exemplo.test/ja-cacheado";
    const missing = "https://exemplo.test/falta";
    saveCachedBody(dir, cached, LONG);
    const calls = stubFetch(() => ({ ok: true, body: LONG }));

    await prefetchUseMelhorBodies(
      [{ url: cached }, { url: missing }, { url: "" }] as Parameters<typeof prefetchUseMelhorBodies>[0],
      dir,
    );

    assert.deepEqual(calls, [missing], "refetch de body já cacheado seria o custo que o cache existe pra evitar");
    assert.equal(loadCachedBody(dir, missing), LONG);
  });

  it("falha num item não derruba os outros (Promise.all sobre funções fail-soft)", async () => {
    const bad = "https://exemplo.test/quebra";
    const good = "https://exemplo.test/ok";
    stubFetch((url) => (url === bad ? new Error("boom") : { ok: true, body: LONG }));

    await assert.doesNotReject(() =>
      prefetchUseMelhorBodies([{ url: bad }, { url: good }] as Parameters<typeof prefetchUseMelhorBodies>[0], dir),
    );
    assert.equal(loadCachedBody(dir, good), LONG);
    assert.equal(loadCachedBody(dir, bad), null);
  });
});

describe("#7668 checkUseMelhorTempoTitleHeuristicShare — invariant warning-only do Stage 4", () => {
  function editionWithArtifact(content: string | null): string {
    const ed = tmp("stage4-tempo-");
    mkdirSync(join(ed, "_internal"), { recursive: true });
    if (content !== null) writeFileSync(join(ed, "_internal", "use-melhor-tempo-source.json"), content, "utf8");
    return ed;
  }

  it("artifact ausente → sem violação (ausência de instrumentação não é erro)", () => {
    assert.deepEqual(checkUseMelhorTempoTitleHeuristicShare(editionWithArtifact(null)), []);
  });

  it("artifact inválido (JSON quebrado / não-array) → sem violação, nunca lança", () => {
    assert.deepEqual(checkUseMelhorTempoTitleHeuristicShare(editionWithArtifact("{ nope")), []);
    assert.deepEqual(checkUseMelhorTempoTitleHeuristicShare(editionWithArtifact('{"a":1}')), []);
  });

  it("todos por wordcount/youtube → sem violação", () => {
    const ed = editionWithArtifact(JSON.stringify([{ source: "wordcount" }, { source: "youtube" }]));
    assert.deepEqual(checkUseMelhorTempoTitleHeuristicShare(ed), []);
  });

  it("1 de 3 por title-heuristic → 1 violação warning com contagem e percentual na mensagem", () => {
    const ed = editionWithArtifact(
      JSON.stringify([{ source: "wordcount" }, { source: "title-heuristic" }, { source: "youtube" }]),
    );
    const v = checkUseMelhorTempoTitleHeuristicShare(ed);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning", "é sinal de qualidade, nunca reprova o gate");
    assert.equal(v[0].rule, "use-melhor-tempo-title-heuristic-share");
    assert.match(v[0].message, /1 de 3 item/);
    assert.match(v[0].message, /33%/);
  });
});
