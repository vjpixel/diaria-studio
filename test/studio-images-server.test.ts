/**
 * test/studio-images-server.test.ts (#6447 Fatia 4, achados 6 + 7 + 9)
 *
 * Contrato HTTP das rotas novas desta fatia — `GET /api/editions/:aammdd/images`,
 * `POST /api/editions/:aammdd/images/:target/regenerate` e
 * `POST /api/editions/:aammdd/gate/approve` — registradas em `server.ts`.
 * Mesmo padrão de `test/studio-review-server.test.ts` (server real via
 * `startStudioServer({port:0})`, requests HTTP de verdade contra tmpdir).
 *
 * A rota de regenerate NUNCA é exercitada de ponta a ponta aqui (spawnaria
 * `image-generate.ts` real — API paga) — só o contrato de validação (400
 * quando falta pré-condição). O comportamento do job em si já é coberto,
 * com `runScript` injetado, em `test/studio-images.test.ts`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

describe("studio-server — imagens + gate approve (#6447 Fatia 4)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-images-server-"));
    mkdirSync(join(root, "data", "editions", "260828", "_internal"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /api/editions/{aammdd}/images — edição sem imagens ainda: available, 3 destaques, tudo exists:false", async () => {
    const res = await fetch(new URL("/api/editions/260828/images", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, true);
    assert.equal(body.destaques.length, 3);
    assert.equal(body.eia.images.length, 2);
  });

  it("GET .../images — edição inexistente: 404", async () => {
    const res = await fetch(new URL("/api/editions/999999/images", server.url));
    assert.equal(res.status, 404);
  });

  it("POST .../images/:target/regenerate — target inválido: 400, nunca dispara nada", async () => {
    const res = await fetch(new URL("/api/editions/260828/images/d9/regenerate", server.url), { method: "POST" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  it("POST .../images/d1/regenerate — sem 02-d1-prompt.md: 400 (pré-condição faltando, nunca spawna image-generate.ts)", async () => {
    const res = await fetch(new URL("/api/editions/260828/images/d1/regenerate", server.url), { method: "POST" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /02-d1-prompt\.md/);
  });

  it("POST /api/editions/{aammdd}/gate/approve — 1ª vez grava e devolve decision", async () => {
    const res = await fetch(new URL("/api/editions/260828/gate/approve", server.url), { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.decision.decision, "approved");
    assert.equal(body.decision.decided_via, "studio");
  });

  it("GET .../gate reflete a decisão gravada no passo anterior", async () => {
    const res = await fetch(new URL("/api/editions/260828/gate", server.url));
    const body = await res.json();
    assert.equal(body.decision?.decision, "approved");
  });

  it("POST .../gate/approve de novo, sem force — 409 conflict", async () => {
    const res = await fetch(new URL("/api/editions/260828/gate/approve", server.url), { method: "POST" });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.conflict, true);
  });

  it("POST .../gate/approve com force:true — sobrescreve com sucesso", async () => {
    const res = await fetch(new URL("/api/editions/260828/gate/approve", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it("POST .../gate/approve — AAMMDD inválido: 400", async () => {
    const res = await fetch(new URL("/api/editions/not-a-date/gate/approve", server.url), { method: "POST" });
    assert.equal(res.status, 400);
  });

  it("POST .../gate/approve — edição inexistente: 404", async () => {
    const res = await fetch(new URL("/api/editions/999999/gate/approve", server.url), { method: "POST" });
    assert.equal(res.status, 404);
  });

  it("GET /revisao.html carrega rv-images.js/css e o botão 'Aprovar gate'", async () => {
    const res = await fetch(new URL("/revisao.html", server.url));
    const html = await res.text();
    assert.match(html, /rv-images\.js/);
    assert.match(html, /rv-images\.css/);
    assert.match(html, /id="rv-gate-approve-btn"/);
    assert.match(html, /id="rv-img-destaques"/);
  });
});
