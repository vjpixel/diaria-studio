/**
 * test/close-poll-stats-schema-guard-4566.test.ts (#4566)
 *
 * Regressão do achado MEDIUM do fleet review da PR #4566 (que introduziu o
 * guard de #4563): os 4 campos numéricos que `/stats` devolve pós-correção
 * (`total`, `voted_a`, `voted_b`, `correct_count`) eram confiados via `?? 0`
 * sem validar o TIPO antes de virarem input de `checkCorrectCountSanity`.
 * Hoje isso é código morto na prática (o Worker sempre devolve esses
 * campos), mas se algum dia o Worker regredir/mudar o schema (parar de
 * devolvê-los, ou devolver um tipo errado), TODOS cairiam em 0 via `?? 0`
 * — `matches` bateria sempre 0 === 0 e o guard do #4563 nunca dispararia,
 * exatamente o padrão "fallback que mascara o problema real" que aquele PR
 * existe pra eliminar, só que um nível abaixo (o CAMINHO que popula o input
 * a partir do JSON de rede não validava isso — o tipo de
 * `CorrectCountSanityInput` já exigia `number`, nunca `number|undefined`,
 * mas nada garantia que o valor lido de `/stats` de fato era um).
 *
 * `validateStatsNumericFields` (pure, extraída em scripts/close-poll.ts)
 * é o fix: falha explícita (`ok:false`) em vez de deixar cair em `?? 0`.
 * `main()` usa isso em 2 pontos — sanity check principal (FATAL/exit se
 * inválido) e releitura pós-mirror --brand web (fail-soft/warning, #4566
 * achado HIGH). Este teste cobre a função pura diretamente — não via spawn
 * — pela mesma disciplina já documentada em
 * close-poll-correct-count-guard-4563.test.ts e
 * close-poll-stats-sig-4125.test.ts: exercitar `process.exit(1)` via spawn
 * real é conhecidamente frágil nesta máquina Windows (crash de libuv
 * pré-existente, ortogonal a este PR). A cobertura da integração real do
 * caminho de AVISO (fail-soft, sem exit) é feita via spawn logo abaixo, sem
 * esse risco.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, type SpawnOptions } from "node:child_process";
import { validateStatsNumericFields } from "../scripts/close-poll.ts";

const isWindows = process.platform === "win32";

// ── validateStatsNumericFields (pure) ────────────────────────────────────

describe("validateStatsNumericFields — guard de schema do #4566", () => {
  it("todos os 4 campos number válidos → ok:true com os campos narrowed", () => {
    const result = validateStatsNumericFields({ total: 14, voted_a: 10, voted_b: 4, correct_count: 4 });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.fields, { total: 14, votedA: 10, votedB: 4, correctCount: 4 });
    }
  });

  it("regressão de schema — TODOS os campos ausentes (Worker parou de devolvê-los): ok:false, nunca ?? 0 silencioso", () => {
    const result = validateStatsNumericFields({});
    assert.equal(result.ok, false, "campos ausentes não devem passar silenciosamente como 0");
    if (!result.ok) {
      assert.match(result.message, /malformada/);
      assert.match(result.message, /#4566/);
    }
  });

  it("correct_count ausente sozinho (os outros 3 presentes): ok:false", () => {
    const result = validateStatsNumericFields({ total: 14, voted_a: 10, voted_b: 4, correct_count: undefined });
    assert.equal(result.ok, false);
  });

  it("campo do tipo errado (string em vez de number): ok:false", () => {
    const result = validateStatsNumericFields({ total: 14, voted_a: 10, voted_b: 4, correct_count: "4" });
    assert.equal(result.ok, false);
  });

  it("campo null: ok:false (null não é number)", () => {
    const result = validateStatsNumericFields({ total: 14, voted_a: 10, voted_b: 4, correct_count: null });
    assert.equal(result.ok, false);
  });

  it("total=0/voted_a=0/voted_b=0/correct_count=0 EXPLÍCITOS (edição real sem votos ainda): ok:true — 0 numérico de verdade não é o mesmo que ausente", () => {
    const result = validateStatsNumericFields({ total: 0, voted_a: 0, voted_b: 0, correct_count: 0 });
    assert.equal(result.ok, true, "0 como number válido não deve ser confundido com campo ausente");
  });
});

// ── main() CLI — wiring do guard no caminho de AVISO (fail-soft, sem exit) ──

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

/**
 * Mock cujo `/stats` da DIÁRIA (sem brand na query) devolve os 4 campos
 * válidos — nunca dispara o guard principal (FATAL) — mas cujo `/stats` do
 * MIRROR (`brand=web` na query) devolve uma resposta malformada (schema
 * regredido: sem total/voted_a/voted_b/correct_count), exercitando só o
 * caminho de AVISO (#4566 achado HIGH), sem risco de exit(1)/libuv.
 */
function startMockPollWorkerWithMalformedWebStats(expectedAnswer: string): Promise<{ server: Server; url: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/admin/correct") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, updated_votes: 1 }));
        return;
      }
      if (url.pathname === "/stats") {
        const brand = url.searchParams.get("brand");
        res.writeHead(200);
        if (brand === "web") {
          // Schema regredido: só correct_answer, sem os 4 campos numéricos.
          res.end(JSON.stringify({ correct_answer: expectedAnswer }));
        } else {
          res.end(JSON.stringify({
            correct_answer: expectedAnswer,
            total: 1,
            voted_a: expectedAnswer === "A" ? 1 : 0,
            voted_b: expectedAnswer === "B" ? 1 : 0,
            correct_count: 1,
          }));
        }
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

describe("close-poll.ts CLI — schema malformado no /stats do mirror --brand web: aviso, NUNCA derruba o processo (#4566)", () => {
  it("mirror com /stats malformado (schema regredido): exit 0, marker da diária gravado normalmente, warning em stderr", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "close-poll-schema-guard-"));
    const { server, url: pollWorkerUrl } = await startMockPollWorkerWithMalformedWebStats("A");

    try {
      const nestedInternalDir = join(editionsDir, "2608", "260801", "_internal");
      mkdirSync(nestedInternalDir, { recursive: true });
      writeFileSync(
        join(nestedInternalDir, "01-eia-meta.json"),
        JSON.stringify({
          edition: "260801",
          composed_at: "2026-08-01T00:00:00.000Z",
          ai_image_file: "01-eia-A.jpg",
          real_image_file: "01-eia-B.jpg",
          ai_side: "A",
          wikimedia: { title: "Foo", image_url: "https://example.com/foo.jpg" },
        }),
      );

      const r = await spawnNpxAsync(
        ["tsx", "scripts/close-poll.ts", "--edition", "260801", "--editions-dir", editionsDir],
        {
          env: {
            ...process.env,
            ADMIN_SECRET: "test-secret-4566-schema",
            POLL_WORKER_URL: pollWorkerUrl,
          },
        },
      );

      assert.equal(r.status, 0, `schema malformado no MIRROR não deve derrubar o close-poll da diária — stderr: ${r.stderr}`);
      assert.match(r.stderr, /aviso \(#4566\).*não foi possível validar o crédito do mirror/);

      const markerPath = join(editionsDir, "2608", "260801", "_internal", ".close-poll-done.json");
      const lastLine = String(r.stdout).trim().split("\n").pop() ?? "";
      const out = JSON.parse(lastLine);
      assert.equal(out.ok, true, "close-poll da diária deve ter sucesso mesmo com o mirror malformado");
      assert.equal(out.marker_path.replaceAll("\\", "/"), markerPath.replaceAll("\\", "/"));
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });
});
