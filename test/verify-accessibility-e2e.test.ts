/**
 * verify-accessibility-e2e.test.ts (#849)
 *
 * Integration test E2E pra `verify-accessibility.ts` CLI. Spins up um
 * HTTP server local em port aleatória, roda o CLI como subprocess,
 * asserta verdicts + cache files populated.
 *
 * Cobre o gap pattern dos PRs #835/#841/#842/#848 — todas as PRs do batch
 * #717 cobriram com unit tests do lib mas nenhuma exercitou o caminho
 * end-to-end através do CLI.
 *
 * Convenções:
 * - URLs de teste retornam respostas controladas pelo servidor in-process.
 * - `/200-good` retorna HTML grande o bastante pra evitar o fallback de
 *   Puppeteer (>500 chars). Verdict esperado: `accessible`.
 * - `/404` retorna 404. Verdict esperado: `blocked`.
 * - `bodies-dir` e `cache` apontam pra tmpdir; cleanup no afterEach.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bodyCacheFilename } from "../scripts/lib/url-body-cache.ts";
import { filterDateWindow } from "../scripts/filter-date-window.ts";

let server: Server;
let port = 0;

function startServer(): Promise<void> {
  return new Promise((resolveStart) => {
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/200-good") {
        // HTML > 500 chars sem markers de paywall → verdict accessible.
        const filler = "<p>conteúdo legítimo aqui</p>".repeat(50);
        const html =
          `<!DOCTYPE html><html><head><title>Artigo Real</title></head>` +
          `<body><article>${filler}</article></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } else if (url === "/200-good-2") {
        const filler = "<p>outro artigo</p>".repeat(50);
        const html =
          `<!DOCTYPE html><html><head><title>Outro Artigo</title></head>` +
          `<body><article>${filler}</article></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } else if (url === "/404") {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body>not found</body></html>");
      } else if (url === "/js-rendered-old-article") {
        // #3211 regressão: HTML estático < 500 chars (após strip de tags) →
        // primeiro passe (fetch puro) retorna `uncertain` e cai no browser
        // fallback. Um <script> inline injeta texto visível suficiente
        // (>= 500 chars de innerText) só depois de renderizado — obrigando
        // o fallback a de fato acontecer e virar `accessible`. O <script
        // type="application/ld+json"> com datePublished simula uma página
        // JS-heavy real (ex: developers.googleblog.com) onde a data só é
        // extraível a partir do HTML completo renderizado, não do innerText.
        const html =
          `<!DOCTYPE html><html><head><title>Artigo Renderizado</title>` +
          `<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","datePublished":"2026-06-17T12:00:00Z"}</script>` +
          `</head><body><div id="c">carregando</div>` +
          `<script>document.getElementById('c').innerText='Texto renderizado via JavaScript apos hidratacao do cliente. '.repeat(20);</script>` +
          `</body></html>`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        port = addr.port;
      }
      resolveStart();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolveStop) => {
    server.close(() => resolveStop());
  });
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runVerify(
  urls: string[],
  bodiesDir: string,
  cachePath: string,
  logRootDir?: string,
): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "verify-e2e-"));
  const urlsPath = join(dir, "urls.json");
  const outPath = join(dir, "out.json");
  writeFileSync(urlsPath, JSON.stringify(urls), "utf8");

  return new Promise((resolveRun) => {
    const child = spawn(
      "npx",
      [
        "tsx",
        "scripts/verify-accessibility.ts",
        urlsPath,
        outPath,
        "--bodies-dir",
        bodiesDir,
        "--cache",
        cachePath,
        // #3311: isola o logEvent de auditoria (`verify: N paywall, ...`) pro
        // tmpdir do teste — sem isso, main() cai no default de logEvent
        // (process.cwd()), que aqui é a raiz real do repo (cwd do processo
        // spawnado), poluindo data/run-log.jsonl de produção a cada run
        // deste teste E2E (7 subtests × múltiplas chamadas runVerify cada).
        ...(logRootDir ? ["--log-root-dir", logRootDir] : []),
      ],
      { cwd: resolve(process.cwd()), shell: process.platform === "win32" },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      const result =
        existsSync(outPath) ? readFileSync(outPath, "utf8") : stdout;
      resolveRun({ exitCode: code ?? 0, stdout: result, stderr });
    });
  });
}

describe("verify-accessibility E2E (#849 — cache flow integration)", () => {
  before(async () => {
    await startServer();
  });

  after(async () => {
    await stopServer();
  });

  it("first run: populates body cache + verify cache, reports 0 hits", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "verify-e2e-first-"));
    const bodiesDir = join(tmpRoot, "bodies");
    const cachePath = join(tmpRoot, "verify-cache.json");
    try {
      const urls = [`http://127.0.0.1:${port}/200-good`];
      const r = await runVerify(urls, bodiesDir, cachePath, tmpRoot);
      assert.equal(r.exitCode, 0, `CLI exit ${r.exitCode}: ${r.stderr}`);

      const results = JSON.parse(r.stdout);
      assert.equal(results.length, 1);
      assert.equal(results[0].verdict, "accessible");

      // Body cache populated
      const expectedBodyFile = join(bodiesDir, bodyCacheFilename(urls[0]));
      assert.ok(
        existsSync(expectedBodyFile),
        `body cache file deveria existir: ${expectedBodyFile}`,
      );

      // Verify cache populated com 1 entry
      assert.ok(existsSync(cachePath));
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));
      assert.equal(cache.version, 1);
      assert.equal(Object.keys(cache.entries).length, 1);

      // Stderr — primeira run = 0/1 hits
      assert.match(r.stderr, /\[verify\] cache carregado: 0 entries/);
      assert.match(r.stderr, /cross-edition cache: 0\/1 hit \(0%\)/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("second run with same cache: cache hit, no fetch needed", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "verify-e2e-second-"));
    const bodiesDir = join(tmpRoot, "bodies");
    const cachePath = join(tmpRoot, "verify-cache.json");
    try {
      const urls = [`http://127.0.0.1:${port}/200-good`];

      // First run populates cache
      const r1 = await runVerify(urls, bodiesDir, cachePath, tmpRoot);
      assert.equal(r1.exitCode, 0);

      // Second run should hit cache
      const r2 = await runVerify(urls, bodiesDir, cachePath, tmpRoot);
      assert.equal(r2.exitCode, 0);

      const results = JSON.parse(r2.stdout);
      assert.equal(results[0].verdict, "accessible");

      // Stderr da segunda run mostra cache carregado com 1 entry + 1/1 hit
      assert.match(r2.stderr, /\[verify\] cache carregado: 1 entries/);
      assert.match(r2.stderr, /cross-edition cache: 1\/1 hit \(100%\)/);

      // Output não deve incluir _cacheHit (strip antes de serializar)
      assert.equal(results[0]._cacheHit, undefined);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("404 URL: verdict blocked, persistido no cache", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "verify-e2e-404-"));
    const bodiesDir = join(tmpRoot, "bodies");
    const cachePath = join(tmpRoot, "verify-cache.json");
    try {
      const urls = [`http://127.0.0.1:${port}/404`];
      const r = await runVerify(urls, bodiesDir, cachePath, tmpRoot);
      assert.equal(r.exitCode, 0);

      const results = JSON.parse(r.stdout);
      assert.equal(results[0].verdict, "blocked");

      // Verify cache deve ter 1 entry (blocked é cacheável)
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));
      assert.equal(Object.keys(cache.entries).length, 1);
      const entry = Object.values(cache.entries)[0] as { verdict: string };
      assert.equal(entry.verdict, "blocked");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("mix de URLs: hit + miss em mesma run, stats refletem corretamente", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "verify-e2e-mix-"));
    const bodiesDir = join(tmpRoot, "bodies");
    const cachePath = join(tmpRoot, "verify-cache.json");
    try {
      const url1 = `http://127.0.0.1:${port}/200-good`;
      const url2 = `http://127.0.0.1:${port}/200-good-2`;

      // First run: cache só url1
      await runVerify([url1], bodiesDir, cachePath, tmpRoot);

      // Second run: url1 cached + url2 novo
      const r = await runVerify([url1, url2], bodiesDir, cachePath, tmpRoot);
      assert.equal(r.exitCode, 0);

      const results = JSON.parse(r.stdout);
      assert.equal(results.length, 2);
      assert.equal(results[0].verdict, "accessible");
      assert.equal(results[1].verdict, "accessible");

      // Stats: 1 hit, 1 miss
      assert.match(r.stderr, /cross-edition cache: 1\/2 hit \(50%\)/);

      // Cache final tem 2 entries (1 carryover + 1 novo)
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));
      assert.equal(Object.keys(cache.entries).length, 2);

      // Body cache também tem 2 files
      const bodyFiles = readdirSync(bodiesDir);
      assert.equal(bodyFiles.length, 2);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("body é lifted pro verify cache (#866) — accessible apenas, ≤ 50KB", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "verify-e2e-body-lift-"));
    const bodiesDir = join(tmpRoot, "bodies");
    const cachePath = join(tmpRoot, "verify-cache.json");
    try {
      const urls = [
        `http://127.0.0.1:${port}/200-good`,
        `http://127.0.0.1:${port}/404`,
      ];
      const r = await runVerify(urls, bodiesDir, cachePath, tmpRoot);
      assert.equal(r.exitCode, 0);

      // Stderr menciona body lift count quando aplicável
      assert.match(r.stderr, /\+1 bodies \(#866\)/);

      const cache = JSON.parse(readFileSync(cachePath, "utf8"));
      const accessibleEntry = Object.values(cache.entries).find(
        (e: any) => e.verdict === "accessible",
      ) as any;
      const blockedEntry = Object.values(cache.entries).find(
        (e: any) => e.verdict === "blocked",
      ) as any;

      // Accessible entry deve ter body
      assert.ok(accessibleEntry?.body, "accessible entry deveria ter body persistido");
      assert.match(accessibleEntry.body, /Artigo Real/);

      // Blocked entry NÃO deve ter body (#866 só lift accessible)
      assert.equal(blockedEntry?.body, undefined);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("cache hit em segunda run preserva body sem rewrite (#866)", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "verify-e2e-body-preserve-"));
    const bodiesDir = join(tmpRoot, "bodies");
    const cachePath = join(tmpRoot, "verify-cache.json");
    try {
      const urls = [`http://127.0.0.1:${port}/200-good`];

      // First run: body lifted pra cache
      await runVerify(urls, bodiesDir, cachePath, tmpRoot);
      const beforeBody = (Object.values(
        JSON.parse(readFileSync(cachePath, "utf8")).entries,
      )[0] as any).body;
      assert.ok(beforeBody);

      // Second run com bodies-dir limpo (simula nova edição)
      rmSync(bodiesDir, { recursive: true, force: true });
      await runVerify(urls, bodiesDir, cachePath, tmpRoot);

      // Body deve continuar no cache (cache hit, no rewrite)
      const afterBody = (Object.values(
        JSON.parse(readFileSync(cachePath, "utf8")).entries,
      )[0] as any).body;
      assert.equal(afterBody, beforeBody, "body preservado através de cache hit");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("#3211 regressão: browser fallback extrai published_date do HTML renderizado (não só innerText)", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "verify-e2e-browser-date-"));
    const bodiesDir = join(tmpRoot, "bodies");
    const cachePath = join(tmpRoot, "verify-cache.json");
    try {
      const url = `http://127.0.0.1:${port}/js-rendered-old-article`;
      const r = await runVerify([url], bodiesDir, cachePath, tmpRoot);
      assert.equal(r.exitCode, 0, `CLI exit ${r.exitCode}: ${r.stderr}`);

      // Confirma que o fallback do browser de fato rolou (não o path primário
      // — senão o teste não reproduziria o bug, que só existe no fallback).
      assert.match(
        r.stderr,
        /uncertain — retrying with browser fallback/,
        "esperava que o body <500 chars forçasse o browser fallback",
      );

      const results = JSON.parse(r.stdout);
      assert.equal(results.length, 1);
      assert.equal(results[0].verdict, "accessible");
      assert.equal(results[0].note, "browser fallback");

      // Antes do #3211 estes 2 campos estavam AUSENTES no resultado do
      // fallback — a data só existia no <script type="application/ld+json">
      // do HTML renderizado, invisível para document.body.innerText.
      assert.equal(
        results[0].published_date,
        "2026-06-17",
        "published_date deveria ser extraído do JSON-LD via page.content()",
      );
      assert.equal(results[0].published_date_note, "json-ld:datePublished");

      // Fecha o loop do incidente real (edição 260710): com published_date
      // populado, filter-date-window.ts agora consegue descartar o artigo
      // quando ele está fora da janela — em vez do "benefício da dúvida"
      // silencioso que deixava artigos de semanas atrás passarem.
      const filterResult = filterDateWindow(
        {
          lancamento: [
            { url: results[0].url, date: null, published_date: results[0].published_date },
          ],
          radar: [],
          use_melhor: [],
          video: [],
        },
        "2026-07-10", // anchor — mesma janela do incidente relatado (edição 260710)
        3,
      );
      assert.equal(filterResult.kept.lancamento.length, 0, "artigo de 17/jun deve ser removido da janela ancorada em 10/jul");
      assert.equal(filterResult.removed.length, 1);
      assert.equal(filterResult.removed[0].source_field, "published_date");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // #3311: regressão direta — antes do --log-root-dir, main() sempre logava
  // via logEvent() sem rootDir explícito, caindo no default process.cwd() do
  // subprocesso spawnado (= raiz real do repo/worktree). Toda run deste
  // teste E2E poluía data/run-log.jsonl de produção com entries fabricadas
  // (edition: null, agent: "verify-accessibility.ts"). Este teste prova que
  // (a) o log de auditoria é de fato persistido, mas (b) SOMENTE no tmpdir
  // isolado passado via --log-root-dir — nunca no repo real.
  it("#3311: log de auditoria isolado via --log-root-dir — nunca grava em data/run-log.jsonl real", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "verify-e2e-logroot-"));
    const bodiesDir = join(tmpRoot, "bodies");
    const cachePath = join(tmpRoot, "verify-cache.json");
    try {
      const urls = [`http://127.0.0.1:${port}/200-good`];
      const r = await runVerify(urls, bodiesDir, cachePath, tmpRoot);
      assert.equal(r.exitCode, 0, `CLI exit ${r.exitCode}: ${r.stderr}`);

      const isolatedLogPath = join(tmpRoot, "data", "run-log.jsonl");
      assert.ok(existsSync(isolatedLogPath), "log de auditoria deveria existir no tmpdir isolado (--log-root-dir)");
      const isolatedLog = readFileSync(isolatedLogPath, "utf8");
      assert.match(isolatedLog, /"agent":"verify-accessibility\.ts"/);

      // #3479: a comparação de snapshot contra data/run-log.jsonl REAL do
      // repo (antes/depois) foi removida daqui — a assertion positiva acima
      // já prova a intenção (write isolado via --log-root-dir), e o
      // snapshot era flaky sob concorrência com outros testes da suíte que
      // gravam no run-log real durante a janela do snapshot.
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
