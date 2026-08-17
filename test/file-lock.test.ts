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
 * Sincronização de início (#5489): `Promise.all` só garante que os 5
 * `execFileAsync` sejam DISPARADOS juntos — não que os 5 processos `npx tsx`
 * TERMINEM o bootstrap (spawn de shell, resolução do `npx`, carregamento do
 * `tsx`/esbuild) e cheguem no início da leitura do contador ao mesmo tempo.
 * Esse bootstrap tem latência variável e, num runner com poucos cores sob
 * carga, o SO pode serializar os 5 o suficiente pra cada ciclo
 * leitura→escrita terminar antes do próximo começar — aí a race nunca ocorre
 * e o teste "SEM lock" falha por sorte de scheduling (não por o bug estar
 * corrigido). Em vez de só aumentar a margem (`n`/`delayMs` maiores — reduz a
 * chance, não elimina), cada processo filho agora ESPERA um arquivo-sinal
 * (`readyPath`) aparecer antes de ler o contador: `runRace` spawna os 5 com o
 * sinal ainda ausente (todos ficam presos no polling), aguarda um intervalo
 * fixo suficiente pra todos passarem do bootstrap do tsx e chegarem no loop
 * de espera, e só então cria o arquivo — os 5 saem do polling e começam a ler
 * o contador aproximadamente ao mesmo tempo. O overlap deixa de depender de
 * sorte de agendamento do SO e passa a ser garantido por construção.
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
const delayMs = Number(args[2]);
const useLock = args[3] === "--use-lock";
const lockPath = counterPath + ".lock";
const readyDeadline = Date.now() + ${READY_TIMEOUT_MS};

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait — sem await, mantém a seção "crítica" síncrona */ }
}

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
 * Intervalo entre spawnar os N processos (com o sinal ainda ausente, todos
 * ficam presos no polling) e criar o arquivo-sinal (#5489). Precisa ser
 * suficiente pra todos os processos passarem do bootstrap do `tsx`/esbuild
 * (a parte de latência variável que motivou este fix) e chegarem no loop de
 * polling — 150ms é generoso frente ao bootstrap típico do tsx (dezenas de
 * ms) mesmo em runner compartilhado; ajustar aqui se a suíte voltar a ficar
 * flaky em CI (nunca localmente — ver validação no PR body).
 */
const STARTUP_MARGIN_MS = 150;

async function runRace(n: number, useLock: boolean): Promise<number> {
  const dir = mkdtempSync(resolve(tmpdir(), "file-lock-race-"));
  const scriptPath = resolve(dir, "racer.mjs");
  const counterPath = resolve(dir, "counter.txt");
  const readyPath = resolve(dir, "ready.signal");
  writeFileSync(scriptPath, counterRacerScript(), "utf8");
  writeFileSync(counterPath, "0", "utf8");

  const args = useLock
    ? [scriptPath, counterPath, readyPath, "30", "--use-lock"]
    : [scriptPath, counterPath, readyPath, "30"];
  const racers = Promise.all(
    Array.from({ length: n }, () => execFileAsync("npx", ["tsx", ...args], { cwd: ROOT, shell: true })),
  );

  // Sinal criado só depois da margem de startup — os N processos, já presos
  // no polling, saem dele e leem o contador aproximadamente ao mesmo tempo.
  await new Promise((r) => setTimeout(r, STARTUP_MARGIN_MS));
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
