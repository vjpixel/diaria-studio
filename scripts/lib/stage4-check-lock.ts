/**
 * stage4-check-lock.ts (#8123 Fatia 3)
 *
 * Coalescing das checagens em background do Stage 4: se o editor pede uma
 * rajada de ajustes ("ajustar" ×N em sequência rápida), o objetivo é UMA
 * rodada de checagem sobre o estado FINAL, não uma por ajuste (issue #8123
 * §3 — "uma rajada de ajustes gera uma rodada sobre o estado final").
 *
 * Mecanismo: um arquivo de lock por edição (`_internal/.stage4-post-edit-
 * checks-lock.json`) guarda `{ running, generation, pid, started_at }`.
 * Regra de uso pelo orchestrator (documentada em
 * `.claude/agents/orchestrator-stage-4.md`):
 *   - Antes de disparar `stage4-post-edit-checks.ts` em background, ler o
 *     lock. Se `running: true` e o PID ainda existir, NÃO disparar de novo —
 *     o run em curso, ao terminar, expõe `inputs_hash` no relatório; o
 *     orchestrator compara esse hash contra o estado ATUAL do arquivo e só
 *     relança se divergir (edição aconteceu DURANTE o run anterior) — nunca
 *     lança 1 processo por ajuste.
 *   - `claimGeneration` incrementa e marca `running: true` ANTES de rodar
 *     os checks (a checagem em si pode demorar). `releaseGeneration` marca
 *     `running: false` DEPOIS — só se a generation ainda for a que este
 *     processo reivindicou (um `claimGeneration` mais novo, que rodou
 *     enquanto este processo ainda checava, NUNCA é sobrescrito de volta
 *     pra `running: false` pelo processo mais velho terminando depois).
 *
 * Falha de leitura/parse do lock (arquivo ausente, JSON corrompido) é
 * fail-soft: trata como estado inicial (`generation: 0, running: false`) —
 * nunca lança exceção. Pior caso de um lock corrompido é rodar a checagem
 * de novo (barato) — não vale travar o Stage 4 por isso.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CheckLockState {
  running: boolean;
  generation: number;
  pid?: number;
  started_at?: string;
}

const DEFAULT_STATE: CheckLockState = { running: false, generation: 0 };

export function readLock(lockPath: string): CheckLockState {
  if (!existsSync(lockPath)) return { ...DEFAULT_STATE };
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<CheckLockState>;
    if (typeof parsed.generation !== "number") return { ...DEFAULT_STATE };
    return {
      running: Boolean(parsed.running),
      generation: parsed.generation,
      pid: parsed.pid,
      started_at: parsed.started_at,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeLock(lockPath: string, state: CheckLockState): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Reivindica a próxima generation e marca `running: true`. Retorna a generation reivindicada. */
export function claimGeneration(lockPath: string): number {
  const current = readLock(lockPath);
  const next = current.generation + 1;
  writeLock(lockPath, {
    running: true,
    generation: next,
    pid: process.pid,
    started_at: new Date().toISOString(),
  });
  return next;
}

/**
 * Marca `running: false` — mas só se `myGeneration` ainda for a generation
 * corrente do lock. Se um `claimGeneration` mais novo já rodou (outra
 * invocação começou antes desta terminar), este release é um no-op — nunca
 * apaga o `running: true` de uma rodada mais nova.
 */
export function releaseGeneration(lockPath: string, myGeneration: number): void {
  const current = readLock(lockPath);
  if (current.generation !== myGeneration) return; // superseded — não mexe
  writeLock(lockPath, { ...current, running: false });
}

/**
 * true quando o PID gravado no lock ainda existe. `process.kill(pid, 0)` não
 * mata nada (sinal 0) — só testa existência/permissão; lança `ESRCH` se o
 * processo não existe. Funciona em POSIX e Windows (Node normaliza sinal 0
 * nas duas plataformas). Fail-open: erro que NÃO seja "processo ausente"
 * (ex: `EPERM` — processo existe mas é de outro usuário) é tratado como
 * "ainda vivo" — mais seguro relançar tarde demais (custo: 1 checagem
 * redundante) do que nunca relançar (custo: Stage 4 inteiro sem checagem
 * de fundo pelo resto da sessão).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * true quando existe um run em curso cuja generation é a mais recente
 * conhecida E cujo processo ainda está vivo (#8123 review — o lock ficava
 * `running: true` pra sempre se o processo em background morresse
 * anormalmente — SIGKILL/OOM/harness derrubando a sessão — entre
 * `claimGeneration` e o `finally { releaseGeneration }`, travando TODAS as
 * checagens de background do Stage 4 pelo resto da sessão, em silêncio).
 * Lock sem `pid` gravado (sentinel antigo, ou escrita manual) é tratado
 * como "ainda rodando" — conservador, mesmo comportamento de antes desta
 * checagem existir.
 */
export function isCheckRunning(lockPath: string): boolean {
  const lock = readLock(lockPath);
  if (!lock.running) return false;
  if (lock.pid === undefined) return true;
  return isPidAlive(lock.pid);
}
