/**
 * test/close-poll-correct-count-guard-4563.test.ts (#4563)
 *
 * Regressão: `close-poll.ts` reportava `ok:true` (sanity check #1367
 * passando) mesmo quando o CRÉDITO (`correct_count`) não tinha sido
 * aplicado corretamente aos votos — só conferia que `/stats.correct_answer`
 * batia com o gabarito recém-gravado, nunca que `/stats.correct_count`
 * refletia quem de fato tinha acertado.
 *
 * Caso real (ciclo 2607-08, issue #4563): gabarito setado para B sobre
 * 10 votos A / 4 votos B. `correct_count` esperado = 4 (quem votou B). O
 * Worker devolveu `correct_count: 10` (o valor de quando o gabarito ainda
 * era A, por engano) e `updated_votes: 0` — nem o sanity check antigo nem o
 * `updated_votes` acusavam nada, e re-rodar close-poll não corrigia.
 *
 * Duas causas-raiz candidatas ficam documentadas na issue (DO StatsCounter
 * stale vs. votos individuais `vote:{edition}:*` não encontrados pra
 * recreditar) — diagnóstico definitivo bloqueado por falta de acesso ao KV
 * do worker `poll` (`wrangler kv key list` retorna erro de autenticação
 * mesmo com token Super Administrator). Este teste NÃO tenta reproduzir a
 * causa raiz — cobre só o guard defensivo: dado um `/stats` pós-correção
 * com `correct_count` que NÃO bate com o esperado, `close-poll.ts` (via
 * `checkCorrectCountSanity`, extraída como função pura testável sem
 * rede/KV) precisa detectar e reportar erro, nunca `ok:true` silencioso.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, type SpawnOptions } from "node:child_process";
import {
  checkCorrectCountSanity,
  type CorrectCountSanityInput,
} from "../scripts/close-poll.ts";
import { StatsCounter } from "../workers/poll/src/stats-counter.ts";
import { makeMockDoState } from "./_helpers/make-mock-do-state.ts";

const isWindows = process.platform === "win32";

// ── checkCorrectCountSanity (pure) — cenário EXATO da issue #4563 ───────────

describe("checkCorrectCountSanity — cenário exato do #4563 (ciclo 2607-08, gabarito B sobre 10A/4B)", () => {
  const base: CorrectCountSanityInput = {
    answer: "B",
    totalVotes: 14,
    votedA: 10,
    votedB: 4,
    correctCountFromStats: 10, // bug real: Worker devolveu 10 (voted_a) em vez de 4 (voted_b)
    updatedVotes: 0, // bug real: updated_votes:0, re-rodar não corrigia
  };

  it("REGRESSÃO EXATA: correct_count=10 quando deveria ser 4 (voted_b) → ok:false, nunca sucesso silencioso", () => {
    const result = checkCorrectCountSanity(base);
    assert.equal(result.ok, false, "correct_count divergente do esperado deve reportar erro, não ok:true");
    assert.equal(result.expectedCorrectCount, 4, "esperado = voted_b, já que o gabarito é B");
    assert.equal(result.legitimateNoop, false, "updated_votes:0 aqui NÃO é legítimo — o crédito está errado");
    assert.match(result.message ?? "", /esperado=4/);
    assert.match(result.message ?? "", /voted_a=10/);
    assert.match(result.message ?? "", /voted_b=4/);
    assert.match(result.message ?? "", /#4563/);
  });

  it("correct_count correto (=4) coincidindo com updated_votes>0: ok:true, sem no-op", () => {
    const result = checkCorrectCountSanity({ ...base, correctCountFromStats: 4, updatedVotes: 4 });
    assert.equal(result.ok, true);
    assert.equal(result.expectedCorrectCount, 4);
    assert.equal(result.legitimateNoop, false, "updated_votes>0 não é um no-op");
  });

  it("correct_count correto (=4) com updated_votes:0: legítimo no-op (ex: reexecução idempotente com o MESMO --answer)", () => {
    const result = checkCorrectCountSanity({ ...base, correctCountFromStats: 4, updatedVotes: 0 });
    assert.equal(result.ok, true, "nada estava errado — os votos já refletiam o gabarito B corretamente");
    assert.equal(result.legitimateNoop, true, "updated_votes:0 é esperado quando nada precisava mudar");
  });

  it("gabarito A (não B): esperado passa a ser voted_a, não voted_b", () => {
    const result = checkCorrectCountSanity({
      answer: "A",
      totalVotes: 14,
      votedA: 10,
      votedB: 4,
      correctCountFromStats: 10,
      updatedVotes: 0,
    });
    assert.equal(result.ok, true);
    assert.equal(result.expectedCorrectCount, 10, "esperado = voted_a quando o gabarito é A");
  });

  it("total=0 (edição sem votos ainda): esperado=0, correct_count=0 → ok:true, nunca legitimateNoop (nada a ajustar)", () => {
    const result = checkCorrectCountSanity({
      answer: "B",
      totalVotes: 0,
      votedA: 0,
      votedB: 0,
      correctCountFromStats: 0,
      updatedVotes: 0,
    });
    assert.equal(result.ok, true);
    assert.equal(result.expectedCorrectCount, 0);
    assert.equal(result.legitimateNoop, false, "total=0 não é o cenário de #4563 item 2 (não há votos existentes pra suspeitar)");
  });

  it("updated_votes>0 MAS correct_count ainda não bate (correção parcial) → ok:false", () => {
    // Cenário hipotético: alguns votos foram recreditados (updated_votes>0)
    // mas o agregado final ainda não reflete o esperado — outro sintoma da
    // mesma classe de bug (DO stale sobrescrevendo o resultado do backfill).
    const result = checkCorrectCountSanity({
      answer: "B",
      totalVotes: 14,
      votedA: 10,
      votedB: 4,
      correctCountFromStats: 7,
      updatedVotes: 2,
    });
    assert.equal(result.ok, false, "mismatch é suficiente pra reportar erro, independente de updated_votes>0");
  });
});

// ── StatsCounter.handleAdjustCorrect — payload inválido nunca ok:true (#4563 item 4) ──

describe("StatsCounter DO /adjust-correct — payload inválido nunca devolve ok:true (#4563 item 4)", () => {
  async function callAdjustCorrect(body: unknown): Promise<{ status: number; json: { ok?: boolean; error?: string; stats?: unknown } }> {
    const counter = new StatsCounter(makeMockDoState());
    const req = new Request("https://internal/adjust-correct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const resp = await counter.fetch(req);
    const json = (await resp.json()) as { ok?: boolean; error?: string; stats?: unknown };
    return { status: resp.status, json };
  }

  it("correct_count negativo → 400, ok NÃO é true", async () => {
    const { status, json } = await callAdjustCorrect({ correct_count: -1 });
    assert.equal(status, 400);
    assert.notEqual(json.ok, true, "payload inválido nunca deve reportar ok:true");
    assert.ok(json.error, "deve trazer diagnóstico do que falhou");
  });

  it("correct_count não-inteiro (float) → 400, ok NÃO é true", async () => {
    const { status, json } = await callAdjustCorrect({ correct_count: 2.5 });
    assert.equal(status, 400);
    assert.notEqual(json.ok, true);
  });

  it("correct_count ausente → 400, ok NÃO é true", async () => {
    const { status, json } = await callAdjustCorrect({});
    assert.equal(status, 400);
    assert.notEqual(json.ok, true);
  });

  it("correct_count do tipo errado (string) → 400, ok NÃO é true", async () => {
    const { status, json } = await callAdjustCorrect({ correct_count: "4" });
    assert.equal(status, 400);
    assert.notEqual(json.ok, true);
  });

  it("sanity: correct_count válido (não-negativo, inteiro) SEMPRE devolve ok:true — guard não é falso-positivo", async () => {
    const { status, json } = await callAdjustCorrect({ correct_count: 4 });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });
});

// ── close-poll.ts CLI fim-a-fim — wiring do guard no marker/stdout ──────────
//
// Nota (mesma disciplina de close-poll-stats-sig-4125.test.ts): exercitar o
// caminho de ERRO (`process.exit(1)`) via spawn real é conhecidamente frágil
// nesta máquina Windows — reproduz um crash de libuv pré-existente e
// ortogonal a este PR (`Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING)`). A cobertura do caminho de erro já está completa via
// `checkCorrectCountSanity` (função pura, acima) — aqui só provamos que
// `main()` de fato PASSA os campos novos de `/stats` pro guard e grava o
// resultado no marker/stdout no caminho de SUCESSO (exit 0, sem crash risk).

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

/** Mock do Worker de poll — /stats devolve o cenário 10A/4B do #4563 já CORRIGIDO (correct_count=4). */
function startMockPollWorkerWithFullStats(): Promise<{ server: Server; url: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/admin/correct") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, updated_votes: 4 }));
        return;
      }
      if (url.pathname === "/stats") {
        res.writeHead(200);
        res.end(JSON.stringify({
          correct_answer: "B",
          total: 14,
          voted_a: 10,
          voted_b: 4,
          correct_count: 4, // já corrigido — cenário SEM o bug do #4563
        }));
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

describe("close-poll.ts CLI — guard passa e grava correct_count/expected_correct_count no marker/stdout (#4563)", () => {
  it("cenário 10A/4B com gabarito B e correct_count já correto (=4): exit 0, marker+stdout trazem os campos novos", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "close-poll-correct-count-guard-"));
    const { server, url: pollWorkerUrl } = await startMockPollWorkerWithFullStats();

    try {
      const nestedInternalDir = join(editionsDir, "2607", "260708", "_internal");
      mkdirSync(nestedInternalDir, { recursive: true });

      const r = await spawnNpxAsync(
        ["tsx", "scripts/close-poll.ts", "--edition", "260708", "--answer", "B", "--editions-dir", editionsDir],
        {
          env: {
            ...process.env,
            ADMIN_SECRET: "test-secret-4563",
            POLL_WORKER_URL: pollWorkerUrl,
          },
        },
      );

      assert.equal(r.status, 0, `esperado exit 0 (correct_count já bate com o esperado) — stderr: ${r.stderr}`);

      const lastLine = String(r.stdout).trim().split("\n").pop() ?? "";
      const out = JSON.parse(lastLine);
      assert.equal(out.ok, true);
      assert.equal(out.sanity_check.correct_count, 4);
      assert.equal(out.sanity_check.expected_correct_count, 4);

      const markerPath = join(editionsDir, "2607", "260708", "_internal", ".close-poll-done.json");
      assert.ok(existsSync(markerPath));
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(marker.sanity_check.correct_count, 4);
      assert.equal(marker.sanity_check.expected_correct_count, 4);
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });
});
