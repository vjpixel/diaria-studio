/**
 * close-poll-nested.test.ts (#3031)
 *
 * Regressão: close-poll.ts montava `data/editions/{edition}` (layout FLAT) à
 * força pra (a) ler _internal/01-eia-meta.json e (b) gravar o marker
 * _internal/.close-poll-done.json — mesmo pós-#3024, quando edições reais
 * passaram a morar no layout NESTED (data/editions/{AAMM}/{AAMMDD}/).
 * Resultado: sem --answer, o script não achava 01-eia-meta.json e abortava;
 * com --answer, gravava o marker num diretório flat órfão que o resume-check
 * e o Stage 5 §5g nunca encontram (mesma classe de bug do #3030, PR #3048).
 *
 * Este teste roda o script via CLI (spawn real) contra uma fixture de edição
 * SÓ no layout nested — sem sibling flat — usando `--editions-dir` (flag
 * adicionada neste PR, só para testabilidade) pra apontar pra um tmpdir em
 * vez do data/editions/ real do repo. A chamada de rede pro Worker de poll é
 * substituída por um mock HTTP local (nunca toca poll.diaria.workers.dev).
 *
 * Falha esperada SEM o fix: o script monta o path flat
 * `{editions-dir}/260707/_internal/01-eia-meta.json`, não encontra o arquivo
 * (só existe em `{editions-dir}/2607/260707/_internal/`) e sai com código 1.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, type SpawnOptions } from "node:child_process";

const isWindows = process.platform === "win32";

/**
 * Variante ASYNC de spawnNpx (test/_helpers/spawn-npx.ts é spawnSync).
 *
 * spawnSync bloqueia o event loop do processo chamador inteiro — inclusive o
 * mock HTTP server que roda no MESMO processo deste teste (node:http só
 * aceita conexões quando o event loop está livre pra rodar). Como o script
 * spawnado precisa fazer requests HTTP de volta pro mock server durante sua
 * execução, o spawn tem que ser assíncrono aqui.
 */
function spawnNpxAsync(
  args: string[],
  opts: SpawnOptions & { env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", args, { shell: isWindows, ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

/** Mock mínimo do Worker de poll (/admin/correct + /stats) — nunca toca produção. */
function startMockPollWorker(expectedAnswer: string): Promise<{ server: Server; url: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/admin/correct") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, updated_votes: 7 }));
        return;
      }
      if (url.pathname === "/stats") {
        res.writeHead(200);
        res.end(JSON.stringify({ correct_answer: expectedAnswer }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("close-poll.ts main() CLI (#3031) — edição no layout NESTED", () => {
  it("lê 01-eia-meta.json do nested e grava o marker no nested (não num flat órfão)", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "close-poll-nested-"));
    const { server, url: pollWorkerUrl } = await startMockPollWorker("A");

    try {
      // Edição 260707 SÓ no layout nested — sem sibling flat.
      const nestedInternalDir = join(editionsDir, "2607", "260707", "_internal");
      mkdirSync(nestedInternalDir, { recursive: true });
      writeFileSync(
        join(nestedInternalDir, "01-eia-meta.json"),
        JSON.stringify({
          edition: "260707",
          composed_at: "2026-07-07T00:00:00.000Z",
          ai_image_file: "01-eia-A.jpg",
          real_image_file: "01-eia-B.jpg",
          ai_side: "A",
          wikimedia: { title: "Foo", image_url: "https://example.com/foo.jpg" },
        }),
      );

      const r = await spawnNpxAsync(
        ["tsx", "scripts/close-poll.ts", "--edition", "260707", "--editions-dir", editionsDir],
        {
          env: {
            ...process.env,
            ADMIN_SECRET: "test-secret-3031",
            POLL_WORKER_URL: pollWorkerUrl,
          },
        },
      );

      assert.equal(r.status, 0, `esperado exit 0 — stderr: ${r.stderr}`);

      const lastLine = String(r.stdout).trim().split("\n").pop() ?? "";
      const out = JSON.parse(lastLine);
      assert.equal(out.ok, true);
      assert.equal(out.edition, "260707");
      assert.equal(out.answer, "A", "deve ter lido ai_side='A' de 01-eia-meta.json (nested)");

      // (b) marker gravado no NESTED, não num flat órfão.
      const nestedMarkerPath = join(editionsDir, "2607", "260707", "_internal", ".close-poll-done.json");
      assert.ok(existsSync(nestedMarkerPath), `marker deve existir em ${nestedMarkerPath}`);

      const marker = JSON.parse(readFileSync(nestedMarkerPath, "utf8"));
      assert.equal(marker.edition, "260707");
      assert.equal(marker.answer, "A");

      const flatSiblingDir = join(editionsDir, "260707");
      assert.ok(
        !existsSync(flatSiblingDir),
        `não deve criar diretório flat órfão em ${flatSiblingDir}`,
      );

      assert.equal(out.marker_path.replaceAll("\\", "/"), nestedMarkerPath.replaceAll("\\", "/"));
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("--answer explícito também grava o marker no nested (sem depender de 01-eia-meta.json)", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "close-poll-nested-answer-"));
    const { server, url: pollWorkerUrl } = await startMockPollWorker("B");

    try {
      // Edição já existe no disco (nested) por outro motivo (ex: imagens já
      // geradas), mas sem 01-eia-meta.json — --answer bypassa a leitura.
      const nestedInternalDir = join(editionsDir, "2607", "260708", "_internal");
      mkdirSync(nestedInternalDir, { recursive: true });

      const r = await spawnNpxAsync(
        [
          "tsx",
          "scripts/close-poll.ts",
          "--edition",
          "260708",
          "--answer",
          "B",
          "--editions-dir",
          editionsDir,
        ],
        {
          env: {
            ...process.env,
            ADMIN_SECRET: "test-secret-3031",
            POLL_WORKER_URL: pollWorkerUrl,
          },
        },
      );

      assert.equal(r.status, 0, `esperado exit 0 — stderr: ${r.stderr}`);

      const nestedMarkerPath = join(editionsDir, "2607", "260708", "_internal", ".close-poll-done.json");
      assert.ok(existsSync(nestedMarkerPath), `marker deve existir em ${nestedMarkerPath}`);

      const flatSiblingDir = join(editionsDir, "260708");
      assert.ok(
        !existsSync(flatSiblingDir),
        `não deve criar diretório flat órfão em ${flatSiblingDir}`,
      );
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });
});
