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
    writeFileSync(
      join(editionDir, "03-social.md"),
      "# LinkedIn\n\n## d1\n\nconteúdo social de teste diar.ia.br\n",
      "utf8",
    );
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

  // #3663 — preview HTML do conteúdo social (03-social.md).
  it("GET .../social-preview.html retorna HTML legível (200) quando 03-social.md existe", async () => {
    const res = await fetch(new URL("/api/editions/260716/social-preview.html", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /<html/i);
    assert.match(html, /LinkedIn/);
    assert.match(html, /conteúdo social de teste diar\.ia\.br/);
  });

  it("GET .../social-preview.html de edição sem 03-social.md retorna 422 com página de erro", async () => {
    const res = await fetch(new URL("/api/editions/260717/social-preview.html", server.url));
    assert.equal(res.status, 422);
    const html = await res.text();
    assert.match(html, /Sem preview/);
  });

  it("GET .../social-preview.html nunca casa com a rota de preview de e-mail (regexes distintas)", async () => {
    // Regressão de rota: garante que o novo endpoint não "vaza" pro handler
    // de preview de e-mail nem vice-versa — cada um lê o arquivo certo.
    const social = await fetch(new URL("/api/editions/260716/social-preview.html", server.url));
    const email = await fetch(new URL("/api/editions/260716/preview.html", server.url));
    assert.equal(social.status, 200);
    assert.equal(email.status, 200);
    const socialHtml = await social.text();
    const emailHtml = await email.text();
    assert.match(socialHtml, /conteúdo social de teste diar\.ia\.br/);
    assert.doesNotMatch(emailHtml, /conteúdo social de teste diar\.ia\.br/);
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

  // #3668 gap 1: o banner PERSISTENTE (sempre visível quando htmlFinalDiverged,
  // independente da aba ativa) tinha a mesma alegação categórica de autoria
  // que o confirm() de saveCurrent() — "editado manualmente" — não decidível
  // só do lado client (um re-render agent-driven do Stage 4 também diverge
  // sem edição manual nenhuma). Cobre o texto estático servido, não só a
  // mensagem do confirm() (essa já coberta em test/revisao-guards.test.ts).
  it("#3668 gap 1: o texto estático do banner de divergência não afirma categoricamente 'editado manualmente'", async () => {
    const res = await fetch(new URL("/revisao/260716", server.url));
    const body = await res.text();
    assert.doesNotMatch(body, /HTML final editado manualmente/);
    assert.match(body, /pode ser edição sua ou re-render do agente/);
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

  // #3663: contrato do wiring aba social → endpoint de preview social —
  // mesmo padrão de teste "só contrato estático" dos casos acima (sem harness
  // jsdom pra simular clique/DOM nesta suíte).
  it("GET /revisao.js referencia social-preview.html pro slug 'social'", async () => {
    const res = await fetch(new URL("/revisao.js", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /social-preview\.html/);
    assert.match(body, /currentSlug === "social"/);
  });

  it("GET /revisao.js importa revisao-prompts.js e referencia prefillMessage", async () => {
    const res = await fetch(new URL("/revisao.js", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /from ["']\.\/revisao-prompts\.js["']/);
    assert.match(body, /prefillMessage/);
  });

  // #3668 — 3 gaps do guard de divergência do HTML final (#3635/PR #3664).
  // Sem harness de DOM neste projeto pra revisao.js (executa `init()` no
  // top-level, referencia `document`/`location`) — mesmo padrão "contrato
  // estático" dos casos acima. A lógica PURA extraível (gap 1 e 2) tem
  // cobertura direta em test/revisao-guards.test.ts; aqui confirmamos o
  // WIRING: que saveCurrent() de fato usa essa lógica em vez da condição
  // antiga, e que a chamada de rede fresca (gap 3) acontece antes da
  // decisão.
  it("GET /revisao.js importa revisao-guards.js e usa shouldConfirmDivergenceGuard (não mais a condição antiga currentSlug !== \"html-final\")", async () => {
    const res = await fetch(new URL("/revisao.js", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /from ["']\.\/revisao-guards\.js["']/);
    assert.match(body, /shouldConfirmDivergenceGuard/);
    assert.match(body, /DIVERGENCE_CONFIRM_MESSAGE/);
    // condição antiga (#3635) não deveria mais existir — ela disparava pra
    // qualquer slug de Markdown, não só 'reviewed' (gap 2).
    assert.doesNotMatch(body, /currentSlug !== "html-final" && htmlFinalDiverged/);
  });

  it("GET /revisao.js — saveCurrent() re-busca o estado de divergência fresco (refreshDivergenceBanner) ANTES de checar htmlFinalDiverged (gap 3, TOCTOU)", async () => {
    const res = await fetch(new URL("/revisao.js", server.url));
    const body = await res.text();
    const fnStart = body.indexOf("async function saveCurrent()");
    assert.ok(fnStart >= 0, "saveCurrent deveria existir em revisao.js");
    const fnEnd = body.indexOf("\nfunction renderDiff", fnStart);
    const fnBody = body.slice(fnStart, fnEnd >= 0 ? fnEnd : undefined);
    assert.match(fnBody, /shouldConfirmDivergenceGuard\(currentSlug\)/);
    const guardIdx = fnBody.indexOf("shouldConfirmDivergenceGuard(currentSlug)");
    const refreshIdx = fnBody.indexOf("await refreshDivergenceBanner()");
    const checkIdx = fnBody.indexOf("if (htmlFinalDiverged)");
    assert.ok(refreshIdx > guardIdx, "refresh deveria vir depois do guard de slug");
    assert.ok(checkIdx > refreshIdx, "a checagem de htmlFinalDiverged deveria vir DEPOIS do refresh fresco, não usar só a flag em memória");
  });

  // #3669 bug 1 — trocar de aba de documento com o painel Preview já aberto
  // deveria disparar um refresh do iframe (antes: só clique explícito na
  // aba lateral "Preview" ou no botão "Atualizar preview" atualizava).
  it("GET /revisao.js — loadFile() dispara refreshPreviewIfOpen() ao final de todos os caminhos de saída, e o helper checa se o painel Preview está aberto", async () => {
    const res = await fetch(new URL("/revisao.js", server.url));
    const body = await res.text();
    const fnStart = body.indexOf("async function loadFile(");
    const fnEnd = body.indexOf("\nfunction refreshPreviewIfOpen", fnStart);
    assert.ok(fnStart >= 0 && fnEnd > fnStart, "loadFile deveria existir e vir antes de refreshPreviewIfOpen");
    const fnBody = body.slice(fnStart, fnEnd);
    const occurrences = fnBody.split("refreshPreviewIfOpen();").length - 1;
    assert.ok(occurrences >= 3, `esperava refreshPreviewIfOpen() nos 3 caminhos de saída de loadFile, achou ${occurrences}`);
    assert.match(body, /function refreshPreviewIfOpen\(\)\s*\{\s*if \(!el\.panePreview\.hidden\)/);
  });

  // #3669 bug 2a — falha de rede em refreshDivergenceBanner() durante init()
  // não pode travar o indicador de conexão em "conectando…" pra sempre.
  it("GET /revisao.js — init() envolve refreshDivergenceBanner() em try/catch e sempre chama setConn em ambos os ramos", async () => {
    const res = await fetch(new URL("/revisao.js", server.url));
    const body = await res.text();
    const fnStart = body.indexOf("async function init()");
    assert.ok(fnStart >= 0, "init deveria existir em revisao.js");
    const fnBody = body.slice(fnStart, body.indexOf("\ninit();", fnStart));
    assert.match(fnBody, /try\s*\{[\s\S]*await refreshDivergenceBanner\(\);[\s\S]*setConn\("ok"\);[\s\S]*\}\s*catch[\s\S]*setConn\("down"\);[\s\S]*\}/);
  });

  // #3669 bug 2b — refreshPreview() virou async (usa await fetchJson no ramo
  // html-final) mas os call sites eram fire-and-forget sem .catch(): falha
  // de rede virava unhandled rejection e o preview ficava em branco sem
  // aviso. Confere: (i) refreshPreview() captura erro internamente e mostra
  // feedback visível via showPreviewError; (ii) os 3 call sites (aba lateral
  // Preview, botão "Atualizar preview", e o novo refreshPreviewIfOpen do bug
  // 1) tratam a rejeição.
  it("GET /revisao.js — refreshPreview() captura erro e mostra feedback visível; todos os call sites tratam a rejeição", async () => {
    const res = await fetch(new URL("/revisao.js", server.url));
    const body = await res.text();
    assert.match(body, /function showPreviewError\(/);
    assert.match(body, /Erro ao carregar preview/);
    const fnStart = body.indexOf("async function refreshPreview()");
    const fnEnd = body.indexOf("\nfunction activateSidePane", fnStart);
    const fnBody = body.slice(fnStart, fnEnd);
    assert.match(fnBody, /try\s*\{/);
    assert.match(fnBody, /catch\s*\(err\)\s*\{\s*showPreviewError\(err\);/);
    const catchSites = body.split("refreshPreview().catch(showPreviewError)").length - 1;
    assert.ok(catchSites >= 3, `esperava .catch(showPreviewError) em pelo menos 3 call sites de refreshPreview(), achou ${catchSites}`);
  });
});
