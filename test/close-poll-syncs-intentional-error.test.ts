/**
 * close-poll-syncs-intentional-error.test.ts (#3210)
 *
 * Regressão: `prep-manual-publish.ts` (fluxo de publicação manual no Beehiiv)
 * nunca chamava `sync-intentional-error.ts` — só o playbook automático
 * (`context/publishers/beehiiv-playbook.md` §0.1, disparado por
 * `/diaria-5-publicacao`) fazia isso. Resultado real (edição 260709,
 * publicada manualmente): `data/intentional-errors.jsonl` nunca recebeu a
 * entry daquela edição — o log pulou direto de 260708 pra 260710 — e
 * §0-replies (Stage 0) não conseguiu creditar um leitor que acertou o erro.
 *
 * `prep-manual-publish.ts` já documenta (imprime no stdout) que o próximo
 * passo pós-publish é `npx tsx scripts/close-poll.ts --edition {edição}` —
 * ou seja, close-poll.ts é o único ponto de código que roda em AMBOS os
 * fluxos (automático E manual). O fix (#3210) faz close-poll.ts chamar
 * `runSyncIntentionalError` (exportada de `sync-intentional-error.ts`)
 * internamente, fechando o gap pra qualquer publicação, presente ou futura.
 *
 * Este teste simula exatamente o cenário do incidente: uma edição com
 * `02-reviewed.md` (com a declaração em prosa "Nessa edição, …" — sem
 * `_internal/intentional-error.json`, replicando uma publicação manual onde
 * o JSON estruturado nunca foi preenchido) e roda close-poll.ts via CLI real
 * (spawn), sem tocar `data/intentional-errors.jsonl` de produção — usa os
 * overrides `--editions-dir` (#3031) e `--intentional-errors-jsonl` (#3210,
 * adicionada neste PR) apontando pra um tmpdir. A chamada de rede pro Worker
 * de poll é substituída por um mock HTTP local.
 *
 * Falha esperada SEM o fix: `close-poll.ts` roda e fecha o poll normalmente,
 * mas `data/intentional-errors.jsonl` nunca é criado/atualizado — o mesmo
 * buraco do incidente real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, type SpawnOptions } from "node:child_process";

const isWindows = process.platform === "win32";

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
        res.end(JSON.stringify({ ok: true, updated_votes: 1 }));
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

describe("close-poll.ts sincroniza intentional-errors.jsonl (#3210)", () => {
  it("edição publicada manualmente (02-reviewed.md com prosa, sem JSON estruturado) recebe entry no jsonl após close-poll", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "close-poll-sync-ie-"));
    const dataDir = mkdtempSync(join(tmpdir(), "close-poll-sync-ie-data-"));
    const { server, url: pollWorkerUrl } = await startMockPollWorker("B");

    try {
      // Simula o estado exato do incidente real (260709): 02-reviewed.md
      // existe com a declaração em prosa, mas NUNCA houve
      // _internal/intentional-error.json preenchido (publicação manual pulou
      // o passo onde o editor forneceria os campos estruturados via chat).
      const editionDir = join(editionsDir, "260709");
      mkdirSync(editionDir, { recursive: true });
      writeFileSync(
        join(editionDir, "02-reviewed.md"),
        [
          "DESTAQUE 1",
          "",
          "MIT lança novo modelo de IA",
          "",
          "---",
          "",
          "**ERRO INTENCIONAL**",
          "",
          "Nessa edição, chamamos o MIT de universidade britânica, mas o correto é universidade americana.",
          "",
          "---",
          "",
        ].join("\n"),
        "utf8",
      );

      const jsonlPath = join(dataDir, "intentional-errors.jsonl");
      assert.ok(!existsSync(jsonlPath), "jsonl não deve existir antes do close-poll (replica o buraco do #3210)");

      const r = await spawnNpxAsync(
        [
          "tsx",
          "scripts/close-poll.ts",
          "--edition",
          "260709",
          "--answer",
          "B",
          "--editions-dir",
          editionsDir,
          "--intentional-errors-jsonl",
          jsonlPath,
        ],
        {
          env: {
            ...process.env,
            ADMIN_SECRET: "test-secret-3210",
            POLL_WORKER_URL: pollWorkerUrl,
          },
        },
      );

      assert.equal(r.status, 0, `esperado exit 0 — stderr: ${r.stderr}`);

      // Marker de close-poll continua sendo gravado normalmente (comportamento
      // pré-existente, não deve regredir).
      const markerPath = join(editionDir, "_internal", ".close-poll-done.json");
      assert.ok(existsSync(markerPath), "marker de close-poll deve existir");

      // O CERNE do fix: jsonl agora existe e tem a entry da edição 260709,
      // mesmo sem _internal/intentional-error.json e sem passar pelo playbook
      // automático — só rodando close-poll.ts, exatamente como o fluxo manual
      // documentado em prep-manual-publish.ts faz.
      assert.ok(existsSync(jsonlPath), "jsonl deve ser criado por close-poll.ts (#3210)");
      const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.edition, "260709");
      assert.equal(entry.source, "prose_block", "sem JSON estruturado, deve cair no fallback de prosa (#1860)");
      assert.match(entry.detail, /MIT|britânica|americana/);
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("idempotente: rodar close-poll.ts 2x não duplica a entry no jsonl", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "close-poll-sync-ie-idem-"));
    const dataDir = mkdtempSync(join(tmpdir(), "close-poll-sync-ie-idem-data-"));
    const { server, url: pollWorkerUrl } = await startMockPollWorker("A");

    try {
      const editionDir = join(editionsDir, "260710");
      mkdirSync(editionDir, { recursive: true });
      writeFileSync(
        join(editionDir, "02-reviewed.md"),
        [
          "**ERRO INTENCIONAL**",
          "",
          "Nessa edição, escrevi X onde deveria ser Y.",
          "",
        ].join("\n"),
        "utf8",
      );
      const jsonlPath = join(dataDir, "intentional-errors.jsonl");

      const env = {
        ...process.env,
        ADMIN_SECRET: "test-secret-3210-idem",
        POLL_WORKER_URL: pollWorkerUrl,
      };
      const baseArgs = [
        "tsx",
        "scripts/close-poll.ts",
        "--edition",
        "260710",
        "--answer",
        "A",
        "--editions-dir",
        editionsDir,
        "--intentional-errors-jsonl",
        jsonlPath,
      ];

      const r1 = await spawnNpxAsync(baseArgs, { env });
      assert.equal(r1.status, 0, `1ª chamada — stderr: ${r1.stderr}`);
      const r2 = await spawnNpxAsync(baseArgs, { env });
      assert.equal(r2.status, 0, `2ª chamada — stderr: ${r2.stderr}`);

      const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1, "2ª chamada não deve duplicar a entry");
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
