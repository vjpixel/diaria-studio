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
      const r = await runVerify(urls, bodiesDir, cachePath);
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
      const r1 = await runVerify(urls, bodiesDir, cachePath);
      assert.equal(r1.exitCode, 0);

      // Second run should hit cache
      const r2 = await runVerify(urls, bodiesDir, cachePath);
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
      const r = await runVerify(urls, bodiesDir, cachePath);
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
      await runVerify([url1], bodiesDir, cachePath);

      // Second run: url1 cached + url2 novo
      const r = await runVerify([url1, url2], bodiesDir, cachePath);
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
});
