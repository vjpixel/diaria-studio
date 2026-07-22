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

  it("#3870: edicao.html expõe o markup do banner de gate pendente no topo do cockpit", async () => {
    const res = await fetch(new URL("/edicao/260716", server.url));
    const body = await res.text();
    assert.ok(body.includes("gate-chat-banner"));
    assert.ok(body.includes("gate-chat-banner-text"));
    assert.ok(body.includes("gate-chat-banner-btn"));
  });

  it("#3870: edicao.js importa gate-chat-bridge.js e monta o botão 'Responder no chat' (wiring cockpit → card do chat drawer)", async () => {
    const res = await fetch(new URL("/edicao.js", server.url));
    const body = await res.text();
    assert.ok(body.includes("gate-chat-bridge.js"), "edicao.js deve importar o módulo puro de decisão da ponte");
    assert.ok(body.includes("Responder no chat"), "deve montar o botão de ação que leva ao card do chat");
    assert.ok(body.includes("esta sessão está rodando no terminal"), "deve explicar a ausência de botão quando o gate é de sessão-terminal (proposta item 2)");
    assert.ok(body.includes("scrollToPendingCard"), "deve chamar a ponte de scroll exposta por chat-drawer.js");
  });

  it("#3870: GET /gate-chat-bridge.js é servido com content-type JS (módulo puro consumido por edicao.js)", async () => {
    const res = await fetch(new URL("/gate-chat-bridge.js", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    const body = await res.text();
    assert.ok(body.includes("resolveGateChatBridge"));
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

  it("#3891 (item 8): edicao.html expõe 'Atualizado HH:MM' no statusbar do cockpit, e edicao.js cronometra o último renderAll()", async () => {
    const html = await (await fetch(new URL("/edicao/260716", server.url))).text();
    assert.ok(html.includes('id="statusbar-updated" aria-live="polite"'), "faltava o elemento de staleness no header do cockpit");

    const js = await (await fetch(new URL("/edicao.js", server.url))).text();
    assert.ok(js.includes("statusbar-updated"), "edicao.js precisa mapear o elemento");
    assert.ok(js.includes("markUpdatedNow"), "precisa existir a função que cronometra o último renderAll()");
  });

  it("#3891 (item 6): edicao.js importa log-dedup.js e guarda pushLogEvents atrás do dedup (reconnect do SSE reenvia a tail inteira via log-init)", async () => {
    const js = await (await fetch(new URL("/edicao.js", server.url))).text();
    assert.ok(js.includes('from "./log-dedup.js"'), "edicao.js precisa importar o deduplicador");
    assert.ok(js.includes("logDeduper.isNew"), "pushLogEvents precisa checar o dedup antes de bufferizar");
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
