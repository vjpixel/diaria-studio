/**
 * scripts/lib/session-lifecycle-report.ts (#6624)
 *
 * Miolo PURO do relatório que responde à pergunta da issue: "sessões
 * coordenadoras (`overnight`/`develop`/`continuo`) terminam sem chamar
 * `session-registry end` com que frequência?".
 *
 * Não faz I/O — recebe as linhas JÁ LIDAS de `data/session-lifecycle.jsonl`
 * (escrito por `endSession`/`garbageCollectSessions` em
 * `scripts/lib/session-registry.ts`, #6624) e agrega. O CLI fino que lê o
 * arquivo de disco é `scripts/session-lifecycle-report.ts`.
 *
 * **Por que este relatório pode vir vazio por dias**: a instrumentação só
 * grava dali pra frente — não há como reconstruir retroativamente se uma
 * sessão passada chamou `end` ou não, porque `endSession` sempre foi
 * `rmSync` puro, sem deixar rastro (ver docstring de `SessionLifecycleEvent`
 * em `session-registry.ts`). A pergunta da issue só tem resposta depois que
 * o log acumular alguns dias/rodadas de sessões coordenadoras terminando —
 * é esperado que este relatório saia "0 eventos" logo após o merge desta
 * unidade, e isso não é falha do mecanismo.
 */
import type { SessionLifecycleEvent, SessionLifecycleEventType } from "./session-registry.ts";

/** Eventos aceitos pelo parser. Evento desconhecido = linha descartada (um
 * consumidor como `check-continuo-session-registration.ts` perderia a janela
 * do tick em silêncio se o tipo novo não entrasse aqui — #10020). */
const KNOWN_EVENTS: ReadonlySet<string> = new Set<SessionLifecycleEventType>([
  "ended",
  "gc-removed-without-end",
  "swept-without-end",
]);

export interface SessionLifecycleSummary {
  totalEvents: number;
  endedCount: number;
  gcRemovedWithoutEndCount: number;
  /** #10020 — ticks do contínuo encerrados pelo sweep de órfãos
   * (`sweep-continuo-orphan-sessions.ts`) sem nunca terem chamado `end`. */
  sweptWithoutEndCount: number;
  /** Proporção de sessões que terminaram SEM chamar `end`
   * (`(gcRemovedWithoutEndCount + sweptWithoutEndCount) / totalEvents`),
   * `null` quando `totalEvents === 0` (nada a dividir — nunca
   * `NaN`/`Infinity` silencioso). O nome ficou o do #6624 por
   * compatibilidade; desde o #10020 inclui os ticks varridos. */
  gcRemovedWithoutEndRatio: number | null;
  /** Contagem por `kind`, só pra quem quiser decompor além do agregado. */
  byKind: Record<string, { ended: number; gcRemovedWithoutEnd: number; sweptWithoutEnd: number }>;
}

/** Parseia uma linha JSONL — `null` para linha vazia ou JSON inválido/shape
 * inesperado (fail-soft, mesma disciplina do resto do módulo de sessão:
 * uma linha corrompida no log não derruba a leitura das demais). */
export function parseSessionLifecycleLine(line: string): SessionLifecycleEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !KNOWN_EVENTS.has(parsed.event) ||
      typeof parsed.kind !== "string" ||
      typeof parsed.sessionId !== "string"
    ) {
      return null;
    }
    return parsed as SessionLifecycleEvent;
  } catch {
    return null;
  }
}

/** Parseia o conteúdo INTEIRO de `data/session-lifecycle.jsonl` (uma linha
 * por evento) — linhas inválidas são descartadas silenciosamente, nunca
 * lançam. Pura. */
export function parseSessionLifecycleLog(content: string): SessionLifecycleEvent[] {
  return content
    .split("\n")
    .map(parseSessionLifecycleLine)
    .filter((e): e is SessionLifecycleEvent => e !== null);
}

/** Agrega uma lista de eventos já parseados no resumo que responde à
 * pergunta da issue. Pura. */
export function summarizeSessionLifecycle(events: readonly SessionLifecycleEvent[]): SessionLifecycleSummary {
  const byKind: Record<string, { ended: number; gcRemovedWithoutEnd: number; sweptWithoutEnd: number }> = {};
  let endedCount = 0;
  let gcRemovedWithoutEndCount = 0;
  let sweptWithoutEndCount = 0;
  for (const e of events) {
    const bucket = (byKind[e.kind] ??= { ended: 0, gcRemovedWithoutEnd: 0, sweptWithoutEnd: 0 });
    if (e.event === "ended") {
      endedCount++;
      bucket.ended++;
    } else if (e.event === "swept-without-end") {
      sweptWithoutEndCount++;
      bucket.sweptWithoutEnd++;
    } else {
      gcRemovedWithoutEndCount++;
      bucket.gcRemovedWithoutEnd++;
    }
  }
  const totalEvents = events.length;
  const withoutEnd = gcRemovedWithoutEndCount + sweptWithoutEndCount;
  return {
    totalEvents,
    endedCount,
    gcRemovedWithoutEndCount,
    sweptWithoutEndCount,
    gcRemovedWithoutEndRatio: totalEvents === 0 ? null : withoutEnd / totalEvents,
    byKind,
  };
}
