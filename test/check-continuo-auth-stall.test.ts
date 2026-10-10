/**
 * test/check-continuo-auth-stall.test.ts (#7647)
 *
 * Regressão da detecção de parada dura por auth no contínuo — o incidente
 * de 08/09/2026, em que o refresh token do Codex foi reusado por outro
 * cliente, o cron passou a falhar com 401/403 e o contínuo parou 7 ticks
 * sem nada no repo notar.
 *
 * **A 1ª versão deste arquivo não testava nada.** Não importava
 * `describe`/`it`/`expect` de lugar nenhum (assumia globais de jest/vitest,
 * e o runner deste repo é `node:test` — o arquivo explodia com
 * `ReferenceError: describe is not defined`, deixando o `test` do CI
 * vermelho); lia o `jobs.json` REAL da máquina, então passava só enquanto o
 * cron estivesse saudável e não era reprodutível em CI nem em outra
 * máquina; e um dos casos lia o fonte por um caminho ABSOLUTO apontando
 * para outro worktree local (`/home/vjpixel/continuo-7647-work/...`), que
 * não existe em lugar nenhum além daquela pasta. Nenhum dos 3 casos cobria
 * `stalled: true` — o comportamento central da função.
 *
 * Aqui cada caso escreve seu próprio `jobs.json` num diretório temporário e
 * injeta o path, que é o motivo de `checkContinuoAuthStall` ter passado a
 * receber `jobsPath` em vez de hardcodá-lo.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkContinuoAuthStall,
  CONTINUO_JOB_ID,
  AUTH_STALL_STREAK_THRESHOLD,
  AUTH_STALL_CODES,
  classifyQuotaError,
} from "../scripts/check-continuo-auth-stall.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "auth-stall-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Escreve um `jobs.json` com o job do contínuo nos estados pedidos. */
function jobsFile(name: string, job: Record<string, unknown> | null): string {
  const path = join(dir, `${name}.json`);
  const jobs = job === null ? [] : [{ id: CONTINUO_JOB_ID, ...job }];
  writeFileSync(path, JSON.stringify({ jobs: [{ id: "outro-job", failure_streak: 9 }, ...jobs] }), "utf8");
  return path;
}

describe("checkContinuoAuthStall — parada dura por auth (#7647)", () => {
  for (const code of AUTH_STALL_CODES) {
    it(`streak no limiar + ${code} → stalled (o caso que motivou a issue)`, () => {
      const r = checkContinuoAuthStall(
        jobsFile(`stall-${code}`, {
          failure_streak: AUTH_STALL_STREAK_THRESHOLD,
          last_auth_error: { code, reason: "token reusado por outro cliente" },
        }),
      );
      assert.equal(r.stalled, true);
      assert.equal(r.lastAuthErrorCode, code);
      assert.match(r.reason, /parada dura por auth/);
      assert.match(r.reason, /token reusado por outro cliente/);
    });
  }

  it("streak ABAIXO do limiar com 401 → não alarma (falha isolada não é parada dura)", () => {
    const r = checkContinuoAuthStall(
      jobsFile("streak-baixo", {
        failure_streak: AUTH_STALL_STREAK_THRESHOLD - 1,
        last_auth_error: { code: 401, reason: "unauthorized" },
      }),
    );
    assert.equal(r.stalled, false);
  });

  it("streak ALTO com 500 → não alarma: é Hermes fora do ar, não credencial", () => {
    const r = checkContinuoAuthStall(
      jobsFile("erro-500", { failure_streak: 9, last_auth_error: { code: 500, reason: "internal" } }),
    );
    assert.equal(r.stalled, false);
    assert.equal(r.lastAuthErrorCode, 500);
  });

  it("streak alto SEM last_auth_error → não alarma (as duas condições são exigidas)", () => {
    const r = checkContinuoAuthStall(jobsFile("sem-erro", { failure_streak: 9 }));
    assert.equal(r.stalled, false);
    assert.equal(r.lastAuthErrorCode, null);
  });

  it("code como string ('403') é normalizado — jobs.json não garante o tipo", () => {
    const r = checkContinuoAuthStall(
      jobsFile("code-string", { failure_streak: 4, last_auth_error: { code: "403", reason: "forbidden" } }),
    );
    assert.equal(r.stalled, true);
    assert.equal(r.lastAuthErrorCode, 403);
  });

  it("code lixo ('abc') vira null, nunca NaN vazando pro veredito", () => {
    const r = checkContinuoAuthStall(
      jobsFile("code-lixo", { failure_streak: 4, last_auth_error: { code: "abc" } }),
    );
    assert.equal(r.stalled, false);
    assert.equal(r.lastAuthErrorCode, null);
  });

  it("job do contínuo ausente → não alarma, e o motivo diz qual job faltou", () => {
    const r = checkContinuoAuthStall(jobsFile("sem-job", null));
    assert.equal(r.stalled, false);
    assert.match(r.reason, new RegExp(CONTINUO_JOB_ID));
  });

  it("jobs.json ausente/ilegível → 'não sei', NUNCA 'está parado' (fail-soft)", () => {
    const r = checkContinuoAuthStall(join(dir, "nao-existe.json"));
    assert.equal(r.stalled, false);
    assert.match(r.reason, /ilegível/);
    assert.equal(r.failureStreak, null);
  });

  it("JSON malformado cai no mesmo fail-soft, sem lançar", () => {
    const path = join(dir, "malformado.json");
    writeFileSync(path, "{ isto não é json", "utf8");
    const r = checkContinuoAuthStall(path);
    assert.equal(r.stalled, false);
    assert.match(r.reason, /ilegível/);
  });
});

describe("parada por COTA lida de last_error (#10001)", () => {
  // Textos literais observados no `jobs.json` do 300 em 10/10/2026 (key
  // truncada) e no dump de request do Hermes de 19/08/2026.
  const OPENROUTER =
    "RuntimeError: HTTP 403: Key limit exceeded (daily limit). Manage it using https://openrouter.ai/workspaces/default/keys/xxx";
  const CODEX =
    "RuntimeError: Error code: 429 - {'error': {'type': 'usage_limit_reached', 'message': 'The usage limit has been reached', 'plan_type': 'go'}}";

  for (const [nome, lastError, code] of [
    ["OpenRouter 403 Key limit exceeded", OPENROUTER, 403],
    ["Codex 429 usage_limit_reached", CODEX, 429],
  ] as const) {
    it(`${nome} + streak alto + auth_code=null → stalled quota (o caso da issue)`, () => {
      const r = checkContinuoAuthStall(
        jobsFile(`quota-${code}`, { failure_streak: 22, last_status: "error", last_error: lastError }),
      );
      assert.equal(r.stalled, true);
      assert.equal(r.stallKind, "quota");
      assert.equal(r.lastAuthErrorCode, code);
      assert.match(r.reason, /parada dura por cota/);
    });

    it(`${nome} com streak abaixo do limiar → não alarma`, () => {
      const r = checkContinuoAuthStall(
        jobsFile(`quota-baixo-${code}`, { failure_streak: AUTH_STALL_STREAK_THRESHOLD - 1, last_error: lastError }),
      );
      assert.equal(r.stalled, false);
      assert.equal(r.stallKind, null);
    });
  }

  it("403/429 genéricos sem a frase de cota → não classificam como cota", () => {
    assert.equal(classifyQuotaError("HTTP 403: Forbidden"), null);
    assert.equal(classifyQuotaError("Error code: 429 - rate_limit_exceeded, retry later"), null);
    assert.equal(classifyQuotaError("Key limit exceeded"), null); // sem o código
    assert.equal(classifyQuotaError(null), null);
    assert.equal(classifyQuotaError(123), null);
  });

  it("last_auth_error 401 vence a cota quando os dois aparecem (diagnóstico mais específico)", () => {
    const r = checkContinuoAuthStall(
      jobsFile("auth-e-cota", {
        failure_streak: 5,
        last_auth_error: { code: 401, reason: "unauthorized" },
        last_error: OPENROUTER,
      }),
    );
    assert.equal(r.stalled, true);
    assert.equal(r.stallKind, "auth");
    assert.equal(r.lastAuthErrorCode, 401);
  });

  it("o watch roteia stallKind=quota para um alarme próprio (STALLED_QUOTA)", () => {
    const sh = readFileSync(resolve(ROOT, "hermes/scripts/watch-continuo-health.sh"), "utf8");
    assert.match(sh, /STALLED_QUOTA/);
    assert.match(sh, /\[watch-continuo\] parada por cota/);
  });
});

describe("bloqueio honesto: o módulo não toca credencial nem pool (#7647)", () => {
  it("não invoca `hermes auth add|remove`, não lê auth.json, não mexe no pool", () => {
    // Lê o fonte por caminho RELATIVO ao repo. A 1ª versão deste teste usava
    // um absoluto apontando pra outro worktree local — passava só naquela
    // máquina, naquela pasta.
    const src = readFileSync(resolve(ROOT, "scripts/check-continuo-auth-stall.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t !== "" && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("//");
      })
      .join("\n");
    assert.doesNotMatch(code, /auth\s+(add|remove)/i);
    assert.doesNotMatch(code, /credential_pool/);
    assert.doesNotMatch(code, /auth\.json/);
  });
});
