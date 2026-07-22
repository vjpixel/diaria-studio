/**
 * test/studio-round-page.test.ts (#3561, fatia 7 do epic "Studio UI" #3554)
 *
 * Contrato HTTP de `GET /api/round/:kind` e `GET /rodada` (server.ts):
 * shell estático servido, payload JSON com o shape esperado a partir de um
 * `plan.json` fixture no disco, guard read-only (só GET/HEAD), 400 pra kind
 * inválido, 200 com `found:false` quando não há sessão nenhuma. Mesmo
 * precedente de `test/studio-triagem-page.test.ts`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
    assert.ok(body.includes("round-kind-tabs"));
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

  it("(#3874) GET /tablist-core.js — helper de navegação de tabs (WAI-ARIA APG) importado por rodada.js/revisao.js — é servido com content-type JS", async () => {
    const res = await fetch(new URL("/tablist-core.js", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  });

  it("(#3874) o shell rodada.html declara role=tab nas abas de kind (aria-selected/tabindex são geridos em runtime por rodada.js, não estáticos no HTML)", async () => {
    const res = await fetch(new URL("/rodada", server.url));
    const body = await res.text();
    assert.ok(body.includes('role="tab"'), "as abas overnight/develop precisam de role=tab (APG)");
    assert.ok(body.includes('id="round-error" class="panel alert-banner" role="alert"'), "banner de erro precisa de role=alert");
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
