/**
 * close-poll-web-mirror-3516.test.ts (#3516)
 *
 * Fundação do "É IA?" standalone (EPIC #3514): a página `/jogar` (brand
 * `web`) reusa o MESMO par de imagens da diária, então fechar o poll da
 * diária (close-poll.ts sem --brand) deve espelhar automaticamente o mesmo
 * gabarito pro brand `web` via `/admin/correct?brand=web` — best-effort,
 * fail-soft (nunca bloqueia o close-poll principal da diária).
 *
 * Cobre:
 *   1. close-poll.ts SEM --brand (fecha a diária) também chama
 *      /admin/correct com brand=web pro MESMO edition/answer.
 *   2. close-poll.ts --brand clarice (ciclo mensal, sem relação com o par
 *      diário) NÃO dispara o mirror — só o branch default aciona.
 *   3. Falha do mirror (mock retorna erro) não derruba o close-poll da
 *      diária — exit 0, marker gravado normalmente (fail-soft).
 *   4. --brand web explícito (generalização do parse, antes só "clarice"
 *      passava) usa o branch genérico existente ("brand não-clarice
 *      futuro") sem precisar de um branch dedicado.
 *
 * Mesmo padrão de spawn+mock HTTP local de close-poll-nested.test.ts —
 * nunca toca poll.diaria.workers.dev.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, type SpawnOptions } from "node:child_process";
import { shouldMirrorToWeb } from "../scripts/close-poll.ts";

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

interface AdminCorrectCall {
  edition: string | null;
  answer: string | null;
  brand: string | null;
}

/** Mock do Worker de poll que REGISTRA cada chamada a /admin/correct (query
 * completa) — permite o teste inspecionar quantas vezes e com quais brands
 * o script chamou o endpoint. `/stats` sempre responde com `expectedAnswer`
 * (não checa brand — mesma simplificação de close-poll-nested.test.ts). */
function startMockPollWorker(
  expectedAnswer: string,
  opts: { adminCorrectStatus?: (brand: string | null) => number } = {},
): Promise<{ server: Server; url: string; calls: AdminCorrectCall[] }> {
  const calls: AdminCorrectCall[] = [];
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/admin/correct") {
        const brand = url.searchParams.get("brand");
        calls.push({
          edition: url.searchParams.get("edition"),
          answer: url.searchParams.get("answer"),
          brand,
        });
        const status = opts.adminCorrectStatus ? opts.adminCorrectStatus(brand) : 200;
        res.writeHead(status);
        res.end(JSON.stringify(status === 200 ? { ok: true, updated_votes: 1 } : { ok: false, error: "mock_error" }));
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
      resolvePromise({ server, url: `http://127.0.0.1:${port}`, calls });
    });
  });
}

function makeEditionFixture(editionsDir: string, edition: string, aiSide: "A" | "B"): void {
  const yymm = edition.slice(0, 4);
  const nestedInternalDir = join(editionsDir, yymm, edition, "_internal");
  mkdirSync(nestedInternalDir, { recursive: true });
  writeFileSync(
    join(nestedInternalDir, "01-eia-meta.json"),
    JSON.stringify({
      edition,
      composed_at: "2026-07-07T00:00:00.000Z",
      ai_image_file: "01-eia-A.jpg",
      real_image_file: "01-eia-B.jpg",
      ai_side: aiSide,
      wikimedia: { title: "Foo", image_url: "https://example.com/foo.jpg" },
    }),
  );
}

describe("close-poll.ts mirror pro brand web (#3516)", () => {
  it("SEM --brand (fecha a diária): TAMBÉM chama /admin/correct?brand=web com o MESMO edition/answer", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "close-poll-web-mirror-"));
    const { server, url: pollWorkerUrl, calls } = await startMockPollWorker("A");

    try {
      makeEditionFixture(editionsDir, "260709", "A");

      const r = await spawnNpxAsync(
        ["tsx", "scripts/close-poll.ts", "--edition", "260709", "--editions-dir", editionsDir],
        {
          env: {
            ...process.env,
            ADMIN_SECRET: "test-secret-3516",
            POLL_WORKER_URL: pollWorkerUrl,
          },
        },
      );

      assert.equal(r.status, 0, `esperado exit 0 — stderr: ${r.stderr}`);

      // 1ª chamada: brand=null (diária, default). 2ª chamada: brand=web (mirror #3516).
      const diariaCalls = calls.filter((c) => c.brand === null);
      const webCalls = calls.filter((c) => c.brand === "web");
      assert.equal(diariaCalls.length, 1, "deve chamar admin/correct 1x sem brand (diária)");
      assert.equal(webCalls.length, 1, "deve chamar admin/correct 1x com brand=web (mirror #3516)");
      assert.equal(webCalls[0].edition, "260709");
      assert.equal(webCalls[0].answer, "A", "mirror usa o MESMO answer da diária");

      assert.match(r.stderr, /gabarito espelhado pro brand=web/);
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  // #3516 nota de isolamento: NÃO testamos `--brand clarice` via spawn real
  // aqui — `monthly-paths.ts` resolve `data/monthly/{cycle}` a partir da
  // RAIZ REAL do repo, sem override testável (diferente de `--editions-dir`
  // da diária, #3031) — um spawn real criaria/escreveria em
  // `data/monthly/2605-06/` de verdade (o mesmo path que a junction OneDrive
  // ocuparia numa máquina configurada). `shouldMirrorToWeb` (pure, exportada
  // de close-poll.ts) isola exatamente a decisão que este teste precisa
  // verificar, sem tocar disco/rede — os testes de rede acima (branch
  // default) e abaixo (fail-soft) já cobrem end-to-end que o mirror
  // funciona quando DEVE disparar.
  it("shouldMirrorToWeb: só true pro branch DEFAULT (brand=null) — clarice e qualquer outro brand explícito não disparam", () => {
    assert.equal(shouldMirrorToWeb(null), true, "fechar a diária (sem --brand) deve espelhar pro web");
    assert.equal(shouldMirrorToWeb("clarice"), false, "ciclo mensal não tem relação com o par diário do standalone");
    assert.equal(shouldMirrorToWeb("web"), false, "--brand web explícito já É o alvo — não espelha de novo pra si mesmo");
  });

  it("mirror falha (mock retorna erro) → NÃO bloqueia o close-poll da diária (fail-soft)", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "close-poll-web-mirror-fail-"));
    const { server, url: pollWorkerUrl, calls } = await startMockPollWorker("A", {
      adminCorrectStatus: (brand) => (brand === "web" ? 500 : 200),
    });

    try {
      makeEditionFixture(editionsDir, "260710", "A");

      const r = await spawnNpxAsync(
        ["tsx", "scripts/close-poll.ts", "--edition", "260710", "--editions-dir", editionsDir],
        {
          env: {
            ...process.env,
            ADMIN_SECRET: "test-secret-3516",
            POLL_WORKER_URL: pollWorkerUrl,
          },
        },
      );

      assert.equal(r.status, 0, `mirror falhando NÃO deve derrubar o close-poll da diária — stderr: ${r.stderr}`);
      assert.match(r.stderr, /aviso \(#3516\).*mirror --brand web falhou/);

      const markerPath = join(editionsDir, "2607", "260710", "_internal", ".close-poll-done.json");
      assert.ok(existsSync(markerPath), "marker da diária deve existir mesmo com o mirror falhando");
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(marker.answer, "A");

      const webCalls = calls.filter((c) => c.brand === "web");
      assert.equal(webCalls.length, 1, "tentou o mirror mesmo assim (só não bloqueou no erro)");
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("--brand web explícito: usa o branch genérico ('brand não-clarice futuro'), sem marker de diária/mensal", async () => {
    const { server, url: pollWorkerUrl, calls } = await startMockPollWorker("A");

    try {
      const r = await spawnNpxAsync(
        [
          "tsx", "scripts/close-poll.ts",
          "--edition", "260711",
          "--brand", "web",
          "--answer", "A",
        ],
        {
          env: {
            ...process.env,
            ADMIN_SECRET: "test-secret-3516",
            POLL_WORKER_URL: pollWorkerUrl,
          },
        },
      );

      assert.equal(r.status, 0, `esperado exit 0 — stderr: ${r.stderr}`);
      const lastLine = String(r.stdout).trim().split("\n").pop() ?? "";
      const out = JSON.parse(lastLine);
      assert.equal(out.ok, true);
      assert.equal(out.brand, "web");
      assert.equal(out.edition, "260711");
      assert.equal(out.answer, "A");
      assert.equal(out.marker_path, undefined, "branch genérico não grava marker de diária/mensal");

      // Chamada explícita --brand web NÃO deve, por sua vez, também disparar
      // o mirror (o mirror só roda no branch default/diária) — sem duplo-mirror.
      const webCalls = calls.filter((c) => c.brand === "web");
      assert.equal(webCalls.length, 1, "só a chamada explícita, sem mirror adicional");
    } finally {
      server.close();
    }
  });
});
