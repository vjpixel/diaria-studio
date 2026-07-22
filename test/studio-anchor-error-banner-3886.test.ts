/**
 * test/studio-anchor-error-banner-3886.test.ts (#3886) — as 3 telas âncora do
 * Studio (home/index, cockpit de edição, revisão de conteúdo) eram as únicas
 * sem a infra de erro que as outras 6 telas já tinham (`id="*-error"` +
 * banner com retry, ver triagem.js:302-311 como referência original):
 *
 *  1. `edicao.js` — `fetchDetail()` engolia `!res.ok` retornando `null` em
 *     silêncio, e qualquer exceção real (rede/JSON inválido) interrompia
 *     `init()` ANTES de `connect()` — o EventSource nunca abria, dot preso em
 *     "conectando…" pra sempre, timeline vazia, zero retry.
 *  2. `app.js`/`index.html` — nenhum `id="error"` existia (grep confirmava
 *     zero ocorrências); só o dot de conexão sinalizava falha do SSE.
 *  3. `revisao.js` — `checkEditionExists()` ficava FORA do try/catch de
 *     `init()` (que só começa depois de `bindEvents()`/`renderTabs()`).
 *
 * Sem harness de DOM neste projeto (ver docstring de
 * test/studio-edicao-page.test.ts) — cobertura via contrato estático
 * (fetch do HTML/JS servido + assert sobre string/regex), mesmo padrão já
 * estabelecido em studio-edicao-page.test.ts/studio-review-server.test.ts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

describe("#3886 — index/app.js ganha banner de erro com retry", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-anchor-error-index-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET / expõe o banner #app-error com botão de retry", async () => {
    const res = await fetch(new URL("/", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('id="app-error"'), "index.html deveria ter o banner de erro dedicado");
    assert.ok(body.includes('id="app-retry-btn"'), "index.html deveria ter o botão de retry");
  });

  it("GET /app.js — connect() fecha uma conexão SSE anterior antes de abrir outra (idempotente, sem leak em retry)", async () => {
    const res = await fetch(new URL("/app.js", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    const fnStart = body.indexOf("function connect()");
    assert.ok(fnStart >= 0, "connect deveria existir em app.js");
    const fnBody = body.slice(fnStart, body.indexOf("\nel.retryBtn.addEventListener", fnStart));
    assert.match(fnBody, /if \(eventSource\) eventSource\.close\(\);/);
  });

  it("GET /app.js — o listener de 'error' do SSE mostra o banner; 'open'/'state' escondem", async () => {
    const res = await fetch(new URL("/app.js", server.url));
    const body = await res.text();
    assert.match(body, /addEventListener\("error", \(\) => \{\s*setConn\("down"\);\s*el\.error\.hidden = false;\s*\}\)/);
    assert.match(body, /addEventListener\("open", \(\) => \{\s*setConn\("ok"\);\s*el\.error\.hidden = true;\s*\}\)/);
  });

  it("GET /app.js — botão de retry chama connect() de novo", async () => {
    const res = await fetch(new URL("/app.js", server.url));
    const body = await res.text();
    assert.match(body, /el\.retryBtn\.addEventListener\("click", \(\) => connect\(\)\);/);
  });
});

describe("#3886 — edicao.js/edicao.html ganham banner de erro com retry; SSE conecta mesmo com fetch inicial falho", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-anchor-error-edicao-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /edicao/:aammdd expõe o banner #edicao-load-error com botão de retry", async () => {
    const res = await fetch(new URL("/edicao/260722", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('id="edicao-load-error"'), "edicao.html deveria ter o banner de erro dedicado");
    assert.ok(body.includes('id="edicao-retry-btn"'), "edicao.html deveria ter o botão de retry");
  });

  it("GET /edicao.js — fetchDetail() lança em !res.ok (não retorna null em silêncio)", async () => {
    const res = await fetch(new URL("/edicao.js", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    const fnStart = body.indexOf("async function fetchDetail()");
    assert.ok(fnStart >= 0, "fetchDetail deveria existir em edicao.js");
    const fnEnd = body.indexOf("\nfunction renderAll", fnStart);
    const fnBody = body.slice(fnStart, fnEnd);
    assert.match(fnBody, /if \(!res\.ok\) throw new Error/);
  });

  it("GET /edicao.js — init() envolve fetchDetail() em try/catch e chama connect() no finally (SSE abre mesmo com fetch inicial falho)", async () => {
    const res = await fetch(new URL("/edicao.js", server.url));
    const body = await res.text();
    const fnStart = body.indexOf("async function init()");
    assert.ok(fnStart >= 0, "init deveria existir em edicao.js");
    const fnEnd = body.indexOf("\nel.retryBtn.addEventListener", fnStart);
    assert.ok(fnEnd > fnStart);
    const fnBody = body.slice(fnStart, fnEnd);
    assert.match(
      fnBody,
      /try\s*\{[\s\S]*await fetchDetail\(\)[\s\S]*el\.loadError\.hidden = true;[\s\S]*\}\s*catch[\s\S]*el\.loadError\.hidden = false;[\s\S]*\}\s*finally\s*\{\s*connect\(\);\s*\}/,
    );
  });

  it("GET /edicao.js — o botão de retry rechama init()", async () => {
    const res = await fetch(new URL("/edicao.js", server.url));
    const body = await res.text();
    assert.match(body, /el\.retryBtn\.addEventListener\("click", \(\) => \{ init\(\); \}\);/);
  });

  it("GET /edicao.js — connect() fecha a conexão SSE anterior antes de abrir outra (retry de init() nunca duplica EventSource)", async () => {
    const res = await fetch(new URL("/edicao.js", server.url));
    const body = await res.text();
    const fnStart = body.indexOf("function connect()");
    assert.ok(fnStart >= 0, "connect deveria existir em edicao.js");
    const fnBody = body.slice(fnStart, body.indexOf("\n// #3871", fnStart));
    assert.match(fnBody, /if \(eventSource\) eventSource\.close\(\);/);
  });

  it("GET /edicao.js — scheduleRefetch() também trata a exceção nova de fetchDetail() (sem virar unhandled rejection)", async () => {
    const res = await fetch(new URL("/edicao.js", server.url));
    const body = await res.text();
    const fnStart = body.indexOf("function scheduleRefetch()");
    assert.ok(fnStart >= 0, "scheduleRefetch deveria existir em edicao.js");
    const fnEnd = body.indexOf("\nasync function init()", fnStart);
    const fnBody = body.slice(fnStart, fnEnd);
    assert.match(fnBody, /try\s*\{[\s\S]*await fetchDetail\(\)[\s\S]*\}\s*catch[\s\S]*\}/);
  });
});

describe("#3886 — revisao.js/revisao.html ganham banner de erro com retry", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-anchor-error-revisao-"));
    mkdirSync(join(root, "data", "editions", "260722"), { recursive: true });
    writeFileSync(join(root, "data", "editions", "260722", "02-reviewed.md"), "conteúdo");
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /revisao/:aammdd expõe o banner #rv-load-error com botão de retry", async () => {
    const res = await fetch(new URL("/revisao/260722", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('id="rv-load-error"'), "revisao.html deveria ter o banner de erro dedicado");
    assert.ok(body.includes('id="rv-retry-btn"'), "revisao.html deveria ter o botão de retry");
  });

  it("GET /revisao.js — checkEditionExists() lança em !res.ok (não retorna false em silêncio)", async () => {
    const res = await fetch(new URL("/revisao.js", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    const fnStart = body.indexOf("async function checkEditionExists()");
    assert.ok(fnStart >= 0, "checkEditionExists deveria existir em revisao.js");
    const fnEnd = body.indexOf("\nasync function init()", fnStart);
    const fnBody = body.slice(fnStart, fnEnd);
    assert.match(fnBody, /if \(!res\.ok\) throw new Error/);
  });

  it("GET /revisao.js — init() envolve a CHAMADA de checkEditionExists() em try/catch (regressão exata do achado #3886: antes ficava fora)", async () => {
    const res = await fetch(new URL("/revisao.js", server.url));
    const body = await res.text();
    const fnStart = body.indexOf("async function init()");
    assert.ok(fnStart >= 0, "init deveria existir em revisao.js");
    const fnEnd = body.indexOf("\nel.retryBtn.addEventListener", fnStart);
    assert.ok(fnEnd > fnStart);
    const fnBody = body.slice(fnStart, fnEnd);
    assert.match(
      fnBody,
      /try\s*\{\s*exists = await checkEditionExists\(\);[\s\S]*el\.loadError\.hidden = true;[\s\S]*\}\s*catch[\s\S]*el\.loadError\.hidden = false;[\s\S]*return;[\s\S]*\}/,
    );
    // bindEvents()/renderTabs() só podem rodar DEPOIS do try/catch — não mais
    // antes dele (era essa a ordem que deixava a exceção destravada).
    const tryIdx = fnBody.indexOf("try {");
    const bindIdx = fnBody.indexOf("bindEvents();");
    assert.ok(bindIdx > tryIdx, "bindEvents() deveria vir depois do try/catch de checkEditionExists()");
  });

  it("GET /revisao.js — o botão de retry rechama init()", async () => {
    const res = await fetch(new URL("/revisao.js", server.url));
    const body = await res.text();
    assert.match(body, /el\.retryBtn\.addEventListener\("click", \(\) => \{ init\(\); \}\);/);
  });
});
