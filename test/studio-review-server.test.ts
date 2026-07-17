/**
 * test/studio-review-server.test.ts (#3559)
 *
 * Contrato HTTP das rotas de revisão de conteúdo rica registradas em
 * `server.ts` — leitura (GET), salvar (PUT), diff, lint, reset-baseline e
 * preview do e-mail, mais o guard de método preservado nas rotas
 * pré-existentes read-only (#3555).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

const TWO_DESTAQUES_MD = [
  "**DESTAQUE 1 | LANÇAMENTO**",
  "",
  "**[IA chega às fábricas brasileiras](https://example.com/1)**",
  "",
  "Corpo do primeiro destaque com contexto suficiente.",
  "",
  "Por que isso importa: automatização industrial tem impacto direto no emprego.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | PESQUISA**",
  "",
  "**[Modelos de linguagem superam humanos em diagnóstico](https://example.com/2)**",
  "",
  "Corpo do segundo destaque.",
  "",
  "Por que isso importa: abre caminho para triagem automatizada em clínicas.",
  "",
].join("\n");

describe("studio-server — revisão de conteúdo rica (#3559)", () => {
  let root: string;
  let server: StudioServer;
  let editionDir: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-review-server-"));
    editionDir = join(root, "data", "editions", "260716");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(join(editionDir, "02-reviewed.md"), TWO_DESTAQUES_MD, "utf8");
    writeFileSync(join(editionDir, "03-social.md"), "# LinkedIn\n\nconteúdo social de teste diar.ia.br", "utf8");
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /api/editions/{aammdd}/review/reviewed retorna o conteúdo + baseline", async () => {
    const res = await fetch(new URL("/api/editions/260716/review/reviewed", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.exists, true);
    assert.equal(body.content, TWO_DESTAQUES_MD);
    assert.equal(body.baseline, TWO_DESTAQUES_MD);
    assert.ok(body.pull); // #494 — best-effort, presente mesmo que falhe
  });

  it("GET com slug desconhecido retorna 400", async () => {
    const res = await fetch(new URL("/api/editions/260716/review/nope", server.url));
    assert.equal(res.status, 400);
  });

  it("PUT salva o conteúdo — reflete em disco e no próximo GET", async () => {
    const novo = TWO_DESTAQUES_MD.replace("automatização industrial", "automação industrial");
    const put = await fetch(new URL("/api/editions/260716/review/reviewed", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: novo }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.equal(putBody.ok, true);

    assert.equal(readFileSync(join(editionDir, "02-reviewed.md"), "utf8"), novo);

    const get = await fetch(new URL("/api/editions/260716/review/reviewed", server.url));
    const getBody = await get.json();
    assert.equal(getBody.content, novo);
    assert.equal(getBody.baseline, TWO_DESTAQUES_MD, "baseline continua a versão original do agente");
  });

  it("PUT sem 'content' no corpo retorna 400", async () => {
    const res = await fetch(new URL("/api/editions/260716/review/reviewed", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    assert.equal(res.status, 400);
  });

  it("GET .../diff reflete a edição feita pelo PUT anterior", async () => {
    const res = await fetch(new URL("/api/editions/260716/review/reviewed/diff", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.isEmpty, false);
    assert.ok(body.lines.some((l: { type: string }) => l.type === "add"));
    assert.ok(body.lines.some((l: { type: string }) => l.type === "del"));
  });

  it("POST .../reset-baseline zera o diff", async () => {
    const reset = await fetch(new URL("/api/editions/260716/review/reviewed/reset-baseline", server.url), {
      method: "POST",
    });
    assert.equal(reset.status, 200);

    const diff = await fetch(new URL("/api/editions/260716/review/reviewed/diff", server.url));
    const body = await diff.json();
    assert.equal(body.isEmpty, true);
  });

  it("GET .../lint roda os checks estruturais do newsletter", async () => {
    const res = await fetch(new URL("/api/editions/260716/review/reviewed/lint", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.checks));
    assert.ok(body.checks.length > 5);
    assert.ok(body.skipped.includes("section-counts"));
  });

  it("GET .../lint pra social roda o conjunto de checks de social", async () => {
    const res = await fetch(new URL("/api/editions/260716/review/social/lint", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.checks.some((c: { id: string }) => c.id === "cta-format"));
  });

  it("GET .../preview.html retorna HTML completo (200) quando o md é válido", async () => {
    const res = await fetch(new URL("/api/editions/260716/preview.html", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /<html/);
  });

  it("GET .../preview.html de edição sem 02-reviewed.md retorna 422 com página de erro", async () => {
    mkdirSync(join(root, "data", "editions", "260717", "_internal"), { recursive: true });
    const res = await fetch(new URL("/api/editions/260717/preview.html", server.url));
    assert.equal(res.status, 422);
    const html = await res.text();
    assert.match(html, /Sem preview/);
  });

  it("POST .../actions/swap-destaque com corpo inválido retorna 400", async () => {
    const res = await fetch(new URL("/api/editions/260716/actions/swap-destaque", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promote: "bucket-invalido", demote: "d1" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  it("POST .../actions/swap-destaque bem-formado, mas sem swap-destaque.ts no rootDir de teste, falha fail-soft (400)", async () => {
    const res = await fetch(new URL("/api/editions/260716/actions/swap-destaque", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promote: "radar:0", demote: "d1", dryRun: true }),
    });
    // rootDir de teste é um tmpdir sem scripts/swap-destaque.ts real — o
    // guard fail-soft de studio-review-actions.ts responde 400 em vez de
    // lançar ou derrubar o servidor.
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error ?? "", /swap-destaque\.ts/);
  });

  it("invariante preservado: POST em rota read-only pré-existente ainda retorna 405", async () => {
    const res = await fetch(new URL("/api/state", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  // #3635 — editor de última milha do HTML final publicado de verdade.
  it("GET .../review/html-final antes da Etapa 4: exists:false, sem erro", async () => {
    const res = await fetch(new URL("/api/editions/260716/review/html-final", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.exists, false);
    // #959/#1022: _internal/* nunca sincroniza com Drive — pull nem tenta.
    assert.equal(body.pull.attempted, false);
  });

  it("PUT .../review/html-final grava _internal/newsletter-final.html (cria a pasta se preciso) e reflete no GET/diff", async () => {
    const put = await fetch(new URL("/api/editions/260716/review/html-final", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "<html><body>final editado à mão</body></html>" }),
    });
    assert.equal(put.status, 200);
    assert.equal(
      readFileSync(join(editionDir, "_internal", "newsletter-final.html"), "utf8"),
      "<html><body>final editado à mão</body></html>",
    );

    const get = await fetch(new URL("/api/editions/260716/review/html-final", server.url));
    const getBody = await get.json();
    assert.equal(getBody.exists, true);
    assert.equal(getBody.content, "<html><body>final editado à mão</body></html>");
    // baseline capturado na 1ª leitura == o conteúdo que acabou de ser
    // escrito pelo PUT acima (nunca tinha sido lido antes) — então o diff
    // deveria estar vazio até uma 2ª edição.
    const diff1 = await fetch(new URL("/api/editions/260716/review/html-final/diff", server.url));
    assert.equal((await diff1.json()).isEmpty, true);

    const put2 = await fetch(new URL("/api/editions/260716/review/html-final", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "<html><body>2ª edição manual</body></html>" }),
    });
    assert.equal(put2.status, 200);
    const diff2 = await fetch(new URL("/api/editions/260716/review/html-final/diff", server.url));
    const diff2Body = await diff2.json();
    assert.equal(diff2Body.isEmpty, false, "diverge do baseline — é este sinal que o guard do painel consome");
  });

  it("GET .../review/html-final/lint não roda checks de Markdown — retorna note explicativa", async () => {
    const res = await fetch(new URL("/api/editions/260716/review/html-final/lint", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.checks, []);
    assert.match(body.note ?? "", /última milha/);
  });

  it("GET /revisao/{aammdd} serve o shell estático da SPA", async () => {
    const res = await fetch(new URL("/revisao/260716", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("Revisão de conteúdo"));
  });

  it("GET /revisao/{aammdd} inclui a aba 'HTML final' (#3635) e o banner de divergência", async () => {
    const res = await fetch(new URL("/revisao/260716", server.url));
    const body = await res.text();
    assert.ok(body.includes('data-slug="html-final"'));
    assert.ok(body.includes('id="rv-divergence-banner"'));
    assert.ok(body.includes('id="rv-html-final-note"'));
  });

  // #3629: smoke/contrato do HTML servido pros ganchos "Reescrever
  // título"/"Regenerar imagem" — `prefillMessage` (chat-drawer.js) é
  // puramente DOM (sem lógica pura extraível além do que já é coberto por
  // `revisao-prompts.js`, ver test/revisao-prompts.test.ts), então a
  // cobertura aqui é de contrato: os elementos que revisao.js espera
  // encontrar via `getElementById` existem no HTML servido, e o script
  // real servido expõe a 3ª função (`prefillMessage`) no objeto global.
  it("GET /revisao/{aammdd} inclui os cards de 'Reescrever título' e 'Regenerar imagem' (não mais stub/gancho)", async () => {
    const res = await fetch(new URL("/revisao/260716", server.url));
    const body = await res.text();
    assert.ok(body.includes("Reescrever título"));
    assert.ok(body.includes("Regenerar imagem"));
    assert.ok(body.includes('id="rv-title-destaque"'));
    assert.ok(body.includes('id="rv-title-instrucao"'));
    assert.ok(body.includes('id="rv-title-fill-btn"'));
    assert.ok(body.includes('id="rv-image-destaque"'));
    assert.ok(body.includes('id="rv-image-instrucao"'));
    assert.ok(body.includes('id="rv-image-fill-btn"'));
    // Stub antigo (#3559) não deve mais aparecer.
    assert.ok(!body.includes("Não implementado nesta fatia"));
  });

  it("GET /chat-drawer.js expõe prefillMessage em window.diariaStudioChat", async () => {
    const res = await fetch(new URL("/chat-drawer.js", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    const body = await res.text();
    assert.match(body, /function prefillMessage\(/);
    assert.match(body, /window\.diariaStudioChat\s*=\s*\{[^}]*prefillMessage/);
  });

  it("GET /revisao-prompts.js serve o módulo com as 2 funções exportadas", async () => {
    const res = await fetch(new URL("/revisao-prompts.js", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /export function buildRewriteTitlePrompt/);
    assert.match(body, /export function buildRegenerateImagePrompt/);
  });

  it("GET /revisao.js importa revisao-prompts.js e referencia prefillMessage", async () => {
    const res = await fetch(new URL("/revisao.js", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /from ["']\.\/revisao-prompts\.js["']/);
    assert.match(body, /prefillMessage/);
  });
});
