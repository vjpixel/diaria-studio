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
 *
 * Sincronização de início (#5489, endurecida #5489-CI): `Promise.all` só
 * garante que os 5 `execFileAsync` sejam DISPARADOS juntos — não que os 5
 * processos `npx tsx` TERMINEM o bootstrap (spawn de shell, resolução do
 * `npx`, carregamento do `tsx`/esbuild) e cheguem no início da leitura do
 * contador ao mesmo tempo. Esse bootstrap tem latência variável e, num
 * runner com poucos cores sob carga, o SO pode serializar os 5 o suficiente
 * pra cada ciclo leitura→escrita terminar antes do próximo começar — aí a
 * race nunca ocorre e o teste "SEM lock" falha por sorte de scheduling (não
 * por o bug estar corrigido).
 *
 * Primeira tentativa (#5489) usava um intervalo FIXO (`STARTUP_MARGIN_MS`)
 * entre spawnar os processos e criar o sinal de início — 150ms, validado
 * 6/6 localmente, mas ainda flakou em CI (achado ao vivo, rodada 260816f):
 * um timer fixo é uma aposta de quanto o bootstrap MAIS LENTO vai demorar,
 * e CI compartilhado tem cauda mais longa que qualquer margem fixa
 * confortável cobre sem inflar o tempo do teste. Trocado por uma BARREIRA
 * real: cada processo filho grava o PRÓPRIO arquivo `{readyPath}.{i}`
 * assim que entra no loop de espera (antes de esperar o sinal de início) —
 * `runRace` poll a até TODOS os N arquivos existirem (com timeout de
 * segurança) antes de criar o sinal de início. O overlap deixa de depender
 * de qualquer estimativa de tempo e passa a ser garantido por construção,
 * não importa o quão lento o bootstrap seja em qualquer runner.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Timeout de segurança do polling do arquivo-sinal, dentro de CADA processo
 * filho (#5489). Existe só pra nunca travar o CI indefinidamente se algo
 * catastrófico impedir `runRace` de criar o sinal (ex: exceção antes do
 * `writeFileSync(readyPath, ...)`) — não é o mecanismo de sincronização em
 * si (esse é o polling normal, que sai assim que o arquivo aparece). 5s é
 * folgado o bastante pra nunca disparar num CI genuinamente lento (o
 * `STARTUP_MARGIN_MS` abaixo — 150ms — já cobre o caso normal, então 5s é
 * >30× essa margem) e curto o bastante pra falhar rápido, e não travar a
 * suíte, se o sinal genuinamente nunca vier.
 */
const READY_TIMEOUT_MS = 5_000;

/**
 * Script standalone (não faz parte do repo) que simula uma seção crítica de
 * read-modify-write: espera o arquivo-sinal `readyPath` aparecer (sincroniza
 * o INÍCIO com os demais processos concorrentes, #5489), lê um contador de
 * `counterPath`, espera `delayMs` (mantém uma janela mínima de overlap
 * mesmo com o sinal já sincronizando o início), incrementa e regrava.
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
const readyPath = args[1];
const selfReadyPath = args[2];
const delayMs = Number(args[3]);
const useLock = args[4] === "--use-lock";
const lockPath = counterPath + ".lock";
const readyDeadline = Date.now() + ${READY_TIMEOUT_MS};

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait — sem await, mantém a seção "crítica" síncrona */ }
}

// Barreira (#5489-CI): sinaliza que ESTE processo chegou no loop de espera
// — o pai só cria o sinal de início depois que TODOS os N tiverem feito o
// mesmo, então nenhum processo lento por bootstrap fica de fora do overlap.
writeFileSync(selfReadyPath, "1", "utf8");

// Espera o sinal de início (#5489) — elimina a dependência de scheduling do
// SO pra fazer os N processos começarem a ler o contador ao mesmo tempo.
while (!existsSync(readyPath)) {
  if (Date.now() >= readyDeadline) {
    throw new Error("[racer] timeout esperando o arquivo-sinal " + readyPath);
  }
  const end = Date.now() + 5;
  while (Date.now() < end) { /* busy wait curto — polling */ }
}

if (useLock) acquireLock(lockPath, 10_000);
try {
  const current = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
  sleep(delayMs); // mantém uma janela mínima de overlap dentro da seção crítica
  writeFileSync(counterPath, String(current + 1), "utf8");
} finally {
  if (useLock) releaseLock(lockPath);
}
`;
}

/**
 * Timeout de segurança da barreira em `runRace` — espera até TODOS os N
 * processos gravarem o próprio `selfReadyPath` antes de criar o sinal de
 * início (#5489-CI). 10s é folgado (>>tempo de bootstrap do tsx mesmo em CI
 * lento) e existe só pra nunca travar a suíte se um processo crashar antes
 * de sinalizar — não é o mecanismo de sincronização em si (esse é a
 * checagem "todos os N arquivos existem", sem estimativa de tempo).
 */
const BARRIER_TIMEOUT_MS = 10_000;

async function waitForAll(paths: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((p) => existsSync(p))) {
    if (Date.now() >= deadline) {
      const missing = paths.filter((p) => !existsSync(p));
      throw new Error(`[runRace] timeout esperando barreira — ${missing.length}/${paths.length} processo(s) nunca sinalizaram pronto`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function runRace(n: number, useLock: boolean): Promise<number> {
  const dir = mkdtempSync(resolve(tmpdir(), "file-lock-race-"));
  const scriptPath = resolve(dir, "racer.mjs");
  const counterPath = resolve(dir, "counter.txt");
  const readyPath = resolve(dir, "ready.signal");
  const selfReadyPaths = Array.from({ length: n }, (_, i) => resolve(dir, `self-ready-${i}.signal`));
  writeFileSync(scriptPath, counterRacerScript(), "utf8");
  writeFileSync(counterPath, "0", "utf8");

  const racers = Promise.all(
    selfReadyPaths.map((selfReadyPath) => {
      const args = useLock
        ? [scriptPath, counterPath, readyPath, selfReadyPath, "30", "--use-lock"]
        : [scriptPath, counterPath, readyPath, selfReadyPath, "30"];
      return execFileAsync("npx", ["tsx", ...args], { cwd: ROOT, shell: true });
    }),
  );

  // Barreira real (#5489-CI): só cria o sinal de início depois que TODOS os
  // N processos já sinalizaram que chegaram no loop de espera — nenhuma
  // estimativa de tempo, robusto a qualquer velocidade de bootstrap.
  await waitForAll(selfReadyPaths, BARRIER_TIMEOUT_MS);
  writeFileSync(readyPath, "1", "utf8");

  await racers;

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
