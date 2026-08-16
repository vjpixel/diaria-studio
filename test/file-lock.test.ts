/**
 * test/file-lock.test.ts (#5434 item 2)
 *
 * `scripts/lib/file-lock.ts` foi extraído em #4125 item 7 (de
 * `social-published-store.ts`) e passou a ser reusado por
 * `preflight-state.ts`, `eia-dispatch-state.ts` e `stage4-capture-state.ts`
 * (#5434) — mas nunca tinha teste próprio: cada consumidor só testava a
 * SEMÂNTICA de upsert com chamadas sequenciais/in-process (ver
 * `test/social-published-store-race.test.ts`, que documenta explicitamente
 * "não dá pra gerar race real entre 2 processos no mesmo test" — `node:test`
 * é single-threaded, então duas chamadas síncronas na mesma suíte nunca se
 * interpõem de verdade).
 *
 * Este teste prova o MECANISMO em si (`acquireLock`/`releaseLock`) usando
 * processos OS reais (`node:child_process`, não `node:worker_threads` —
 * mais simples e já é o padrão do repo) com um delay artificial DENTRO da
 * seção crítica simulada, forçando a janela de overlap a ser determinística
 * em vez de depender de sorte de agendamento do SO (o que se mostrou
 * pouco confiável experimentalmente: rodar `preflight-state.ts --set` via
 * `npx tsx` 5× em paralelo raramente colide na prática, porque o bootstrap
 * do tsx/V8 domina o tempo total e a seção crítica real — ler+gravar um JSON
 * pequeno — dura microssegundos).
 *
 * Sem lock: N processos incrementando o mesmo contador concorrentemente
 * perdem updates (cada um lê o mesmo valor antes de qualquer um gravar).
 * Com lock: nenhum update se perde — é exatamente a garantia que
 * `preflight-state.ts`/`eia-dispatch-state.ts`/`stage4-capture-state.ts`
 * passaram a depender no #5434 item 2.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Script standalone (não faz parte do repo) que simula uma seção crítica de
 * read-modify-write: lê um contador de `counterPath`, espera `delayMs`
 * (força overlap real entre processos concorrentes), incrementa e regrava.
 * `--use-lock` envolve a seção com `acquireLock`/`releaseLock` de
 * `scripts/lib/file-lock.ts` — sem a flag, roda sem proteção nenhuma (baseline
 * pra provar que a race é reproduzível quando ninguém serializa o acesso).
 */
function counterRacerScript(): string {
  return `
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { acquireLock, releaseLock } from ${JSON.stringify(resolve(ROOT, "scripts/lib/file-lock.ts"))};

const args = process.argv.slice(2);
const counterPath = args[0];
const delayMs = Number(args[1]);
const useLock = args[2] === "--use-lock";
const lockPath = counterPath + ".lock";

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait — sem await, mantém a seção "crítica" síncrona */ }
}

if (useLock) acquireLock(lockPath, 10_000);
try {
  const current = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
  sleep(delayMs); // força overlap determinístico entre processos concorrentes
  writeFileSync(counterPath, String(current + 1), "utf8");
} finally {
  if (useLock) releaseLock(lockPath);
}
`;
}

async function runRace(n: number, useLock: boolean): Promise<number> {
  const dir = mkdtempSync(resolve(tmpdir(), "file-lock-race-"));
  const scriptPath = resolve(dir, "racer.mjs");
  const counterPath = resolve(dir, "counter.txt");
  writeFileSync(scriptPath, counterRacerScript(), "utf8");
  writeFileSync(counterPath, "0", "utf8");

  const args = useLock ? [scriptPath, counterPath, "30", "--use-lock"] : [scriptPath, counterPath, "30"];
  await Promise.all(
    Array.from({ length: n }, () => execFileAsync("npx", ["tsx", ...args], { cwd: ROOT, shell: true })),
  );

  const final = Number(readFileSync(counterPath, "utf8"));
  rmSync(dir, { recursive: true, force: true });
  return final;
}

describe("scripts/lib/file-lock.ts — race real entre processos OS (#5434 item 2)", () => {
  it("SEM lock: N processos concorrentes incrementando o mesmo contador perdem updates", async () => {
    const n = 5;
    const final = await runRace(n, false);
    assert.ok(
      final < n,
      `esperava perda de updates sem lock (final < ${n}), recebeu ${final} — se isso falhar, o ambiente ` +
        "não está reproduzindo overlap real; não é evidência de que o bug foi corrigido",
    );
  });

  it("COM lock (acquireLock/releaseLock): N processos concorrentes não perdem NENHUM update", async () => {
    const n = 5;
    const final = await runRace(n, true);
    assert.equal(final, n, `esperava ${n} (nenhum update perdido), recebeu ${final}`);
  });
});
