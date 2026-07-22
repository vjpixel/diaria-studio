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

  // #3871: idade do último evento pra um stage "current" — módulo puro
  // servido separado (mesmo padrão de revisao-guards.js), mais o contrato
  // estático de que edicao.js de fato importa e usa a função (cobertura
  // direta da lógica em test/edicao-stage-age.test.ts).
  it("GET /edicao-stage-age.js serve o módulo com computeStageAge exportado", async () => {
    const res = await fetch(new URL("/edicao-stage-age.js", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    const body = await res.text();
    assert.match(body, /export function computeStageAge/);
  });

  it("GET /edicao.js importa edicao-stage-age.js e usa computeStageAge no render da timeline (#3871)", async () => {
    const res = await fetch(new URL("/edicao.js", server.url));
    const body = await res.text();
    assert.match(body, /from ["']\.\/edicao-stage-age\.js["']/);
    assert.match(body, /computeStageAge\(stage, logBuffer\)/);
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

// #3870: wiring da ponte cockpit → card do gate no chat drawer. Sem harness de
// DOM neste projeto (precedente documentado no header deste arquivo), o wiring
// é verificado no nível dos assets servidos: a API existe no drawer, o cockpit
// a consome, o banner tem o mount point, e o texto antigo de beco-sem-saída
// ("Interação pela UI é #3557, fora desta fatia") não volta.
describe("ponte cockpit → gate do chat (#3870)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-gate-bridge-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("chat-drawer.js expõe focusPendingGate/hasPendingGate na API global", async () => {
    const js = await (await fetch(new URL("/chat-drawer.js", server.url))).text();
    assert.match(js, /function focusPendingGate\(/);
    assert.match(js, /function hasPendingGate\(/);
    assert.match(js, /hasPendingGate,\s*\n\s*focusPendingGate/, "API exportada em window.diariaStudioChat");
    assert.match(js, /chat-permission-card:not\(\.resolved\)/, "seletor de card pendente");
  });

  it("edicao.js consome a ponte e renderiza banner + CTA", async () => {
    const js = await (await fetch(new URL("/edicao.js", server.url))).text();
    assert.match(js, /focusPendingGate/);
    assert.match(js, /appendPendingGateStatus/);
    assert.match(js, /renderGateBanner/);
    assert.match(js, /a UI só observa/, "fallback de sessão-terminal explica a ausência de botão");
    assert.doesNotMatch(js, /fora desta fatia/, "texto antigo de beco-sem-saída não volta (#3870)");
  });

  it("edicao.html tem o mount do banner de gate", async () => {
    const html = await (await fetch(new URL("/edicao/260716", server.url))).text();
    assert.match(html, /id="gate-banner"/);
    assert.match(html, /aria-live="polite"/);
  });

  it("edicao.css estiliza o CTA com alvo de toque ≥44px (R12)", async () => {
    const css = await (await fetch(new URL("/edicao.css", server.url))).text();
    assert.match(css, /\.gate-cta\s*\{[^}]*min-height:\s*44px/);
  });
});
