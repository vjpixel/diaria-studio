/**
 * clarice-envio-engajados-state.ts (#6945)
 *
 * Estado durável da automação diária do grupo `engajados` — persistido em
 * `data/clarice-subscribers/engajados-state.json` (mesmo diretório de
 * `novos-state.json`/`.envio-run.lock`, arquivo dedicado e novo). Só guarda
 * o que `proposeEngajadosVolume` precisa pra escalar de um dia pro outro: o
 * volume da ÚLTIMA rodada CONFIRMADA.
 *
 * "Confirmada" é deliberado: `lastVolume` só avança depois que
 * `clarice-schedule-group.ts --schedule` confirma o agendamento (GET-verify
 * já embutido naquele script) — uma rodada PULADA (kill switch desligado,
 * ciclo não pronto, lock já travado por outra sessão, assunto A/B/C ainda
 * não travado) NUNCA escreve este arquivo. Isso significa que pular um dia
 * não perde a escalada: a rodada seguinte ainda escala a partir do último
 * volume REAL, só adiada — nunca reseta pro bootstrap por causa de um dia
 * vazio (comportamento testado, ver `test/clarice-envio-engajados-run.test.ts`).
 *
 * Fail-soft de leitura (mesmo padrão de `clarice-novos-state.ts`/
 * `clarice-envio-enabled.ts`): arquivo ausente/corrompido/shape inesperado
 * -> `null`, nunca lança — `proposeEngajadosVolume(null)` já trata isso como
 * "1ª rodada" (bootstrap).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { CLARICE_BASE } from "./clarice-paths.ts";

export interface EngajadosState {
  /** Volume da última rodada CONFIRMADA (agendamento verificado). */
  lastVolume: number;
  /** ISO — quando essa rodada foi confirmada. */
  lastSentAtIso: string;
  /** Ciclo de envio (`{conteúdo}-{envio}`) da última rodada confirmada — só informativo/auditoria. */
  lastCycle: string;
}

/** Path do state file. `baseDir` opcional — mesmo padrão `--data-root` do resto do projeto (uso de teste). */
export function engajadosStatePath(baseDir: string = CLARICE_BASE): string {
  return resolve(baseDir, "engajados-state.json");
}

/** Lê o state file. Tolerante: ausente/corrompido/shape inesperado -> `null` (nunca lança) — "1ª rodada". */
export function readEngajadosState(baseDir: string = CLARICE_BASE): EngajadosState | null {
  const p = engajadosStatePath(baseDir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<EngajadosState>;
    if (
      typeof raw.lastVolume === "number" &&
      Number.isFinite(raw.lastVolume) &&
      typeof raw.lastSentAtIso === "string" &&
      typeof raw.lastCycle === "string"
    ) {
      return { lastVolume: raw.lastVolume, lastSentAtIso: raw.lastSentAtIso, lastCycle: raw.lastCycle };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Grava o novo estado — único ponto de escrita. Não é fail-soft (mesma
 * disciplina de `setClariceNovosEnabled`): uma falha silenciosa aqui faria
 * a próxima rodada escalar a partir de um número desatualizado sem avisar
 * ninguém. Escrita atômica (`writeFileAtomic`) — mesmo padrão do resto do
 * projeto pra estado lido por processos concorrentes.
 */
export function writeEngajadosState(state: EngajadosState, baseDir: string = CLARICE_BASE): void {
  const p = engajadosStatePath(baseDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(state, null, 2) + "\n");
}
