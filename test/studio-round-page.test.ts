/**
 * test/studio-round-page.test.ts (#3561, fatia 7 do epic "Studio UI" #3554;
 * redesenho da sequência cronológica #3841)
 *
 * Contrato HTTP de `GET /api/round/:kind[?session=]`, `GET /api/rounds` e
 * `GET /rodada` (server.ts): shell estático servido, payload JSON com o
 * shape esperado a partir de um `plan.json` fixture no disco, guard
 * read-only (só GET/HEAD), 400 pra kind inválido, 200 com `found:false`
 * quando não há sessão nenhuma. Mesmo precedente de
 * `test/studio-triagem-page.test.ts`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

describe("GET /rodada + GET /api/round/:kind (#3561)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-round-page-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    const dir = join(root, "data", "overnight", "260716");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "plan.json"),
      JSON.stringify({
        started_at: "2026-07-16T10:00:00Z",
        loop_estendido: false,
        issues: [
          { number: 1, priority: "P1", status: "elegivel" },
          { number: 2, priority: "P2", status: "pulada", motivo: "not-this-week" },
        ],
      }),
    );
    // #3841: 2ª sessão do MESMO dia (sufixo `b`), mais ANTIGA (started_at e
    // mtime anteriores à 260716 acima) — cobre `GET /api/rounds` (sequência
    // cronológica) e `GET /api/round/:kind?session=` (busca uma entrada que
    // NÃO é a mais recente do kind).
    const dirB = join(root, "data", "overnight", "260716b");
    mkdirSync(dirB, { recursive: true });
    const planB = join(dirB, "plan.json");
    writeFileSync(
      planB,
      JSON.stringify({
        started_at: "2026-07-16T08:00:00Z",
        issues: [{ number: 3, priority: "P3", status: "mergeada" }],
      }),
    );
    // mtime explícito, mais ANTIGO que o de `260716/plan.json` acima — sem
    // isto, escrever este arquivo DEPOIS faria seu mtime real ser mais
    // recente e `findLatestPlanPath` (que ordena por mtime, #3841) passaria a
    // devolvê-lo como "o mais recente", quebrando os testes pré-existentes
    // que esperam `sessionId: "260716"`.
    const older = new Date("2026-07-16T08:05:00Z");
    utimesSync(planB, older, older);
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serve o shell rodada.html", async () => {
    const res = await fetch(new URL("/rodada", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("rodada.js"));
    // #3841: abas overnight/develop deram lugar à lista cronológica única.
    assert.ok(body.includes('id="rounds-list"'));
  });

  it("aceita /rodada/ com trailing slash", async () => {
    const res = await fetch(new URL("/rodada/", server.url));
    assert.equal(res.status, 200);
  });

  it("GET /rodada.js e /rodada.css são servidos com content-type correto", async () => {
    const js = await fetch(new URL("/rodada.js", server.url));
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);

    const css = await fetch(new URL("/rodada.css", server.url));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  });

  it("regression #3915 (item 10): .round-meta tem breakpoint próprio (1 coluna) + overflow-wrap na dd — não estoura em telas estreitas", async () => {
    const css = await fetch(new URL("/rodada.css", server.url));
    const body = await css.text();
    // causa-raiz (conteúdo sem ponto de quebra, ex: planPath) — corrigida
    // independente de breakpoint.
    assert.match(body, /\.round-meta dd\s*\{\s*margin:\s*0;\s*overflow-wrap:\s*anywhere;\s*\}/);
    // squeeze de 2 colunas em telas estreitas — mesmo breakpoint (640px) já
    // usado pelo resto do arquivo (.round-list-row/.round-kind-tab).
    const mediaMatch = body.match(/@media \(max-width: 640px\) \{([\s\S]*)\}\s*$/);
    assert.ok(mediaMatch, "deveria existir um @media (max-width: 640px) no fim do arquivo");
    assert.match(mediaMatch![1], /\.round-meta\s*\{\s*grid-template-columns:\s*1fr;\s*\}/);
  });

  it("(#3874) GET /tablist-core.js — helper de navegação de tabs (WAI-ARIA APG) importado por rodada.js/revisao.js — é servido com content-type JS", async () => {
    const res = await fetch(new URL("/tablist-core.js", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  });

  it("(#3874) o shell rodada.html mantém role=alert nos banners de erro (lista + detalhe)", async () => {
    const res = await fetch(new URL("/rodada", server.url));
    const body = await res.text();
    assert.ok(body.includes('id="rounds-list-error" class="panel alert-banner" role="alert"'), "banner de erro da lista precisa de role=alert");
    assert.ok(body.includes('id="round-error" class="panel alert-banner" role="alert"'), "banner de erro do detalhe precisa de role=alert");
  });

  it("POST /rodada é rejeitado com 405 (guard read-only)", async () => {
    const res = await fetch(new URL("/rodada", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("GET /api/round/overnight retorna a fila classificada + timeline do plan.json fixture", async () => {
    const res = await fetch(new URL("/api/round/overnight", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.found, true);
    assert.equal(body.sessionId, "260716");
    assert.equal(body.queue.entram.length, 1);
    assert.equal(body.queue.entram[0].number, 1);
    assert.equal(body.queue.fora.length, 1);
    assert.equal(body.queue.fora[0].reason, "not-this-week");
    assert.ok(Array.isArray(body.timeline));
  });

  // #3889: `updatedAt` — mtime real do plan.json, consumido por rodada.js
  // pro rótulo "atualizado" (corrige o falso-frescor de `new Date()` local).
  it("(#3889) GET /api/round/overnight inclui updatedAt (mtime do plan.json), não timestamp do request", async () => {
    const res = await fetch(new URL("/api/round/overnight", server.url));
    const body = await res.json();
    assert.ok(body.updatedAt, "updatedAt deve estar presente quando a sessão é encontrada");
    assert.ok(!Number.isNaN(new Date(body.updatedAt).getTime()), "updatedAt deve ser um ISO válido");
  });

  // #3889: `rodada-round-age.js` — módulo puro de idade/staleness importado
  // por rodada.js (mesmo padrão de edicao-stage-age.js/#3871) — precisa ser
  // servido com content-type JS pra funcionar como ES module no browser.
  it("(#3889) GET /rodada-round-age.js é servido com content-type JS", async () => {
    const res = await fetch(new URL("/rodada-round-age.js", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  });

  // #3841 item 2/3 — sequência cronológica de todas as rodadas.
  it("GET /api/rounds lista TODAS as sessões (inclusive sufixo b), ordenadas por started_at desc", async () => {
    const res = await fetch(new URL("/api/rounds", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.ok(Array.isArray(body.rounds));
    const overnightEntries = body.rounds.filter((r: { kind: string }) => r.kind === "overnight");
    assert.equal(overnightEntries.length, 2, "260716 e 260716b devem aparecer, nenhuma invisível");
    // Mais recente primeiro: 260716 (started_at 10:00Z) antes de 260716b (08:00Z).
    assert.equal(overnightEntries[0].sessionId, "260716");
    assert.equal(overnightEntries[1].sessionId, "260716b");
    assert.equal(overnightEntries[0].startedAt, "2026-07-16T10:00:00Z");
    assert.equal(overnightEntries[0].startedAtSource, "plan");
    assert.equal(overnightEntries[1].totalIssues, 1);
  });

  it("GET /api/round/overnight?session=260716b retorna o DETALHE da sessão antiga, não a mais recente", async () => {
    const res = await fetch(new URL("/api/round/overnight?session=260716b", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.found, true);
    assert.equal(body.sessionId, "260716b");
    assert.equal(body.queue.entram.length, 1);
    assert.equal(body.queue.entram[0].number, 3);
  });

  it("GET /api/round/overnight?session=999999 (sessão inexistente) -> found:false, sem 500", async () => {
    const res = await fetch(new URL("/api/round/overnight?session=999999", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.found, false);
  });

  it("GET /api/round/overnight?session=../../etc (path traversal) -> found:false, não escapa data/overnight/", async () => {
    const res = await fetch(new URL("/api/round/overnight?session=" + encodeURIComponent("../../etc"), server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.found, false);
    assert.match(body.error ?? "", /sessionId inválido/);
  });

  it("POST /api/rounds é rejeitado com 405 — reforça o guard read-only", async () => {
    const res = await fetch(new URL("/api/rounds", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("GET /api/round/develop retorna found:false quando não há sessão develop", async () => {
    const res = await fetch(new URL("/api/round/develop", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.found, false);
    assert.equal(body.error, null);
  });

  it("GET /api/round/xyz (kind inválido) -> 400", async () => {
    const res = await fetch(new URL("/api/round/xyz", server.url));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /kind inválido/);
  });

  it("POST /api/round/overnight é rejeitado com 405 — reforça o guard read-only", async () => {
    const res = await fetch(new URL("/api/round/overnight", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("resposta de /api/round/:kind não inclui nenhum token/segredo — só o shape normalizado", async () => {
    const res = await fetch(new URL("/api/round/overnight", server.url));
    const raw = await res.text();
    assert.ok(!/ghp_|gho_|github_pat_/.test(raw), "resposta não deve conter padrão de token do GitHub");
  });
});
