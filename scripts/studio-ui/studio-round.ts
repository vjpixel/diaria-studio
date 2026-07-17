/**
 * studio-round.ts (#3561, fatia 7 do epic "Studio UI" #3554)
 *
 * Monta o payload de `GET /api/round/:kind` (`kind` = "overnight" |
 * "develop"): fila classificada (`studio-round-queue.ts`) + timeline por
 * unidade sobre o `plan.json` MAIS RECENTE daquele kind. A timeline reusa
 * `buildTimelineRows` de `render-overnight-timeline.ts` (#2637) — a MESMA
 * função pura que já formata a timeline impressa no relatório final da
 * Fase 2, sem duplicar a lógica de agrupamento por lote/duração/fix-iterations.
 *
 * Read-only por construção: só lê `data/{kind}/{AAMMDD}/plan.json` do disco
 * (via `findLatestPlanPath`, o MESMO helper que `studio-state.ts`/
 * `plan-watch.ts` já usam pra achar a sessão mais recente — não duplica essa
 * busca), nunca escreve nem dispara nada. Visualização de uma rodada já em
 * andamento/resumível — #3561 escopo explícito: "não inventar mecanismo de
 * disparo do zero, o disparo real continua sendo /diaria-overnight`/
 * `/diaria-develop` no terminal".
 */

import { readFileSync } from "node:fs";
import { findLatestPlanPath } from "./studio-state.ts";
import { buildRoundQueue, type RawPlan, type RoundQueue } from "./studio-round-queue.ts";
import { buildTimelineRows, type TimelineRow, type Plan as TimelinePlan } from "../render-overnight-timeline.ts";

export type RoundKind = "overnight" | "develop";

export function isRoundKind(value: string): value is RoundKind {
  return value === "overnight" || value === "develop";
}

export interface RoundPayload {
  kind: RoundKind;
  found: boolean;
  /** Path do plan.json relativo a `rootDir`, "/" mesmo no Windows — `null`
   * quando não há nenhuma sessão encontrada. */
  planPath: string | null;
  /** AAMMDD do diretório da sessão (`data/{kind}/{AAMMDD}/`) — pode ser a
   * data-rótulo de início da rodada, não necessariamente a edição-alvo. */
  sessionId: string | null;
  startedAt: string | null;
  /** overnight-only (`loop_estendido`) — `null` quando ausente (develop, ou
   * plan.json legado). */
  loopEstendido: boolean | null;
  queue: RoundQueue;
  timeline: TimelineRow[];
  error: string | null;
}

function toRelative(rootDir: string, absPath: string): string {
  const rel = absPath.startsWith(rootDir) ? absPath.slice(rootDir.length) : absPath;
  return rel.replace(/^[\\/]+/, "").split("\\").join("/");
}

function emptyPayload(kind: RoundKind, error: string | null = null): RoundPayload {
  return {
    kind,
    found: false,
    planPath: null,
    sessionId: null,
    startedAt: null,
    loopEstendido: null,
    queue: { entram: [], pendente: [], fora: [] },
    timeline: [],
    error,
  };
}

/**
 * Monta o payload completo pro `kind` dado, a partir do `plan.json` mais
 * recente em `data/{kind}/`. Fail-soft: sessão ausente, arquivo ilegível ou
 * JSON corrompido nunca lançam — retornam `found:false` + `error` preenchido
 * (mesmo padrão de `summarizePlan` em `studio-state.ts`), pra nunca derrubar
 * a rota HTTP.
 */
export function buildRoundPayload(rootDir: string, kind: RoundKind): RoundPayload {
  const planPath = findLatestPlanPath(rootDir, kind);
  if (!planPath) return emptyPayload(kind);

  let raw: string;
  try {
    raw = readFileSync(planPath, "utf8");
  } catch (e) {
    return emptyPayload(kind, `falha ao ler plan.json: ${(e as Error).message}`);
  }

  let plan: RawPlan;
  try {
    plan = JSON.parse(raw) as RawPlan;
  } catch (e) {
    return emptyPayload(kind, `plan.json inválido: ${(e as Error).message}`);
  }

  const sessionId = planPath.split(/[\\/]/).slice(-2, -1)[0] ?? null;

  return {
    kind,
    found: true,
    planPath: toRelative(rootDir, planPath),
    sessionId,
    startedAt: typeof plan.started_at === "string" ? plan.started_at : null,
    loopEstendido: typeof (plan as { loop_estendido?: unknown }).loop_estendido === "boolean"
      ? (plan as { loop_estendido: boolean }).loop_estendido
      : null,
    queue: buildRoundQueue(plan),
    timeline: buildTimelineRows(plan as unknown as TimelinePlan),
    error: null,
  };
}
