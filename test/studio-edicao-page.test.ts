/**
 * test/studio-edicao-page.test.ts (#3558) — cockpit da edição: a rota
 * `/edicao/:aammdd` faz rewrite pro shell estático (`public/edicao.html`),
 * e os assets novos (`edicao.js`, `edicao.css`) são servidos normalmente
 * pelo mesmo `static-serve.ts` (#3555) — sem lógica server nova além do
 * rewrite. A página em si (fetch de `/api/state` + `/api/editions/:aammdd`
 * + SSE `/api/events`, render da timeline/gates/log) roda no browser e não
 * tem harness de DOM neste projeto (ver `package.json` — sem jsdom/happy-dom);
 * o precedente já estabelecido por `app.js`/#3555 é o mesmo: cobertura via
 * integração no nível do servidor (as APIs que a página consome já têm
 * cobertura própria em `studio-server.test.ts`/`studio-state.test.ts`/
 * `studio-edition-detail.test.ts`), não unit test de DOM. Documentado
 * também no PR body (#2038 self-review).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

describe("GET /edicao/:aammdd (#3558)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-edicao-page-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serve o shell edicao.html pra qualquer AAMMDD (validação real acontece client-side via /api/editions)", async () => {
    const res = await fetch(new URL("/edicao/260716", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("edicao.js"));
    assert.ok(body.includes("stage-timeline"));
    assert.ok(body.includes("gate-4"));
    assert.ok(body.includes("gate-6"));
  });

  it("aceita AAMMDD com trailing slash", async () => {
    const res = await fetch(new URL("/edicao/260716/", server.url));
    assert.equal(res.status, 200);
  });

  it("(#3874) banner 'não encontrado' e lista de alertas têm role=alert; log da edição tem aria-live", async () => {
    const res = await fetch(new URL("/edicao/260716", server.url));
    const body = await res.text();
    assert.ok(body.includes('id="edicao-not-found" class="panel alert-banner" role="alert"'));
    assert.ok(body.includes('id="alerts-list" role="alert" aria-live="polite"'));
    assert.ok(body.includes('id="edicao-log-list" class="log-list" aria-live="polite"'));
  });

  it("continua servindo o shell mesmo pra AAMMDD que não existe no disco — o 404 real vem de /api/editions no browser", async () => {
    const res = await fetch(new URL("/edicao/999999", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("edicao-not-found"));
  });

  it("GET /edicao.js é servido com content-type JS", async () => {
    const res = await fetch(new URL("/edicao.js", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  });

  it("GET /edicao.css é servido com content-type CSS", async () => {
    const res = await fetch(new URL("/edicao.css", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
  });

  it("POST /edicao/260716 continua rejeitado com 405 (guard read-only vale pra toda rota, #3555)", async () => {
    const res = await fetch(new URL("/edicao/260716", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("a API que a página consome expõe os campos que edicao.js precisa (timeline + gates)", async () => {
    mkdirSync(join(root, "data", "editions", "260716"), { recursive: true });
    writeFileSync(join(root, "data", "editions", "260716", "02-reviewed.md"), "x");

    const res = await fetch(new URL("/api/editions/260716", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.found, true);
    assert.ok(Array.isArray(body.gateFacingFiles));
    assert.ok(body.gateFacingFiles.some((f: { name: string }) => f.name === "02-reviewed.md"));
    assert.ok("gatesPending" in body);
    assert.ok("currentStage" in body);
  });
});
