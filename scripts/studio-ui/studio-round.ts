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
 *
 * #3841 item 2/3 — `listRoundSummaries`: o painel deixou de mostrar só "a
 * rodada mais recente" (por kind) e passou a listar TODAS as rodadas
 * (overnight + develop) numa sequência cronológica única — decisão de
 * produto do editor (260721, ver corpo da issue): "múltiplas rodadas no
 * mesmo dia são tratadas EXATAMENTE como rodadas de dias diferentes — sem
 * caso especial pra 'mesmo dia'". `buildRoundPayload` ganhou um 3º parâmetro
 * opcional `sessionId` pra buscar o DETALHE de uma entrada específica da
 * sequência (não só a mais recente do kind) quando o editor expande uma
 * entrada da lista.
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  findLatestPlanPath,
  listSessionCandidates,
  resolveStartedAt,
  AAMMDD_SESSION_RE,
} from "./studio-state.ts";
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
  /** #3841: ISO 8601 resolvido — `plan.started_at` quando é um ISO parseável
   * (skills novas), ou fallback pro mtime do `plan.json` quando ausente/
   * legado (string `{AAMMDD}`/`{AAMMDD}{sufixo}`, não parseável como data —
   * era a causa raiz de "INICIADA EM: 01/01, 00:00"). Ver `startedAtSource`. */
  startedAt: string | null;
  /** `"plan"` quando `startedAt` veio de `plan.started_at` (identidade real
   * de rodada, gravada pela skill); `"mtime"` quando é o fallback (sessão
   * legada) — `null` só quando `found:false`. UI pode rotular como
   * aproximado nesse 2º caso. */
  startedAtSource: "plan" | "mtime" | null;
  /** mtime do `plan.json` no disco (ISO) — timestamp de quando os DADOS
   * mudaram por último de verdade, não de quando esta resposta HTTP foi
   * gerada (#3889). O client (`rodada.js`) usa este campo pro rótulo
   * "atualizado" em vez de `new Date()` local: uma rodada travada (plan.json
   * parado de escrever) deixa de exibir "atualizado agora" a cada refresh —
   * o rótulo só avança quando o arquivo de fato muda. `null` só quando o stat
   * falha (corrida rara entre `findLatestPlanPath` e este `statSync` — o
   * arquivo já foi lido com sucesso acima, então isto é fail-soft por
   * precaução, não o caminho esperado). */
  updatedAt: string | null;
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
    startedAtSource: null,
    updatedAt: null,
    loopEstendido: null,
    queue: { entram: [], pendente: [], fora: [] },
    timeline: [],
    error,
  };
}

/**
 * Monta o payload completo pro `kind` dado. Sem `sessionId`, usa o
 * `plan.json` mais recente em `data/{kind}/` (via `findLatestPlanPath` —
 * comportamento pré-#3841 preservado, é o que os call-sites antigos e os
 * testes de `/api/round/:kind` sem `?session=` esperam). Com `sessionId`
 * (#3841 item 2/3 — o painel expandindo uma entrada específica da sequência
 * cronológica), busca o `plan.json` DAQUELE diretório de sessão, não
 * necessariamente o mais recente.
 *
 * `sessionId` é validado contra `AAMMDD_SESSION_RE` antes de virar path —
 * vem de query string (entrada não confiável), então a validação também é
 * defesa contra path traversal (`../../etc`, etc. nunca casam o regex de 6
 * dígitos + sufixo opcional).
 *
 * Fail-soft: sessão ausente, arquivo ilegível ou JSON corrompido nunca
 * lançam — retornam `found:false` + `error` preenchido (mesmo padrão de
 * `summarizePlan` em `studio-state.ts`), pra nunca derrubar a rota HTTP.
 */
export function buildRoundPayload(rootDir: string, kind: RoundKind, sessionId?: string): RoundPayload {
  let planPath: string | null;
  if (sessionId) {
    if (!AAMMDD_SESSION_RE.test(sessionId)) {
      return emptyPayload(kind, `sessionId inválido: ${sessionId}`);
    }
    const candidate = resolve(rootDir, "data", kind, sessionId, "plan.json");
    planPath = existsSync(candidate) ? candidate : null;
  } else {
    planPath = findLatestPlanPath(rootDir, kind);
  }
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

  // Nome do diretório de sessão derivado do planPath resolvido — cobre tanto
  // o caso "mais recente" (planPath achado por `findLatestPlanPath`) quanto o
  // caso `sessionId` explícito (já validado acima); reusa o mesmo parsing pra
  // não duplicar a lógica de derivação.
  const resolvedSessionId = planPath.split(/[\\/]/).slice(-2, -1)[0] ?? null;

  // #3889: mtime real do plan.json — ver doc-comment de `updatedAt` acima.
  // Fail-soft: o arquivo já foi lido com sucesso (readFileSync acima), então
  // uma falha aqui seria uma corrida rara (arquivo removido entre as duas
  // chamadas) — nunca deve derrubar a rota.
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(planPath).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  const updatedAt = mtimeMs !== null ? new Date(mtimeMs).toISOString() : null;

  // #3841 item 1/2: `started_at` de sessões novas (pós-fix do SKILL.md) é um
  // ISO 8601 real — `resolveStartedAt` usa direto. Sessões legadas (só a
  // string `{AAMMDD}`/`{AAMMDD}{sufixo}`, não parseável como data) caem no
  // fallback de mtime, em vez de propagar um valor não-ISO que o client
  // (`rodada.js` → `fmtTime`) não consegue formatar (o sintoma original do
  // defeito B — "INICIADA EM: 01/01, 00:00"). `startedAtSource` deixa a UI
  // rotular a hora como aproximada quando veio do fallback.
  const { iso: startedAt, source: startedAtSource } = resolveStartedAt(
    plan.started_at,
    mtimeMs ?? Date.now(),
  );

  return {
    kind,
    found: true,
    planPath: toRelative(rootDir, planPath),
    sessionId: resolvedSessionId,
    startedAt,
    startedAtSource,
    updatedAt,
    loopEstendido: typeof (plan as { loop_estendido?: unknown }).loop_estendido === "boolean"
      ? (plan as { loop_estendido: boolean }).loop_estendido
      : null,
    queue: buildRoundQueue(plan),
    timeline: buildTimelineRows(plan as unknown as TimelinePlan),
    error: null,
  };
}

/** 1 entrada da sequência cronológica de `GET /api/rounds` (#3841 item 2/3) —
 * resumo o bastante pra render a lista sem buscar cada `plan.json` por
 * completo (a UI busca o detalhe completo via `GET /api/round/:kind?session=`
 * só quando o editor expande a entrada). */
export interface RoundListEntry {
  kind: RoundKind;
  /** Nome do diretório de sessão (`{AAMMDD}` ou `{AAMMDD}{sufixo}`). */
  sessionId: string;
  /** Path relativo a `rootDir`, "/" mesmo no Windows. */
  planPath: string;
  /** ISO 8601 resolvido — ver `resolveStartedAt` em `studio-state.ts`. Campo
   * de ORDENAÇÃO da sequência (mais recente primeiro). */
  startedAt: string;
  startedAtSource: "plan" | "mtime";
  /** mtime do `plan.json` (ISO) — mesmo campo de `RoundPayload.updatedAt`. */
  updatedAt: string;
  totalIssues: number;
  /** status -> contagem, mesmo formato de `PlanSummary.counts` (`studio-state.ts`). */
  counts: Record<string, number>;
}

function toRelativeRoot(rootDir: string, absPath: string): string {
  const rel = absPath.startsWith(rootDir) ? absPath.slice(rootDir.length) : absPath;
  return rel.replace(/^[\\/]+/, "").split("\\").join("/");
}

/**
 * Lista TODAS as rodadas (overnight + develop) numa sequência cronológica
 * única, mais recente primeiro (#3841 item 2/3 — decisão de produto do
 * editor, 260721: "múltiplas rodadas no mesmo dia são tratadas EXATAMENTE
 * como rodadas de dias diferentes — sem caso especial pra 'mesmo dia'").
 * Substitui a antiga UX de "1 rodada por kind" do painel `/rodada` — cada
 * `kind` deixa de competir por um único slot "mais recente" e vira só mais um
 * atributo da entrada na sequência.
 *
 * Fail-soft por entrada: um `plan.json` ilegível/corrompido é simplesmente
 * OMITIDO da lista (não derruba a rota nem contamina as demais entradas) —
 * mesmo espírito de `summarizePlan`, só que aqui "retornar null" vira "pular
 * esta entrada" em vez de propagar um payload de erro por item.
 */
export function listRoundSummaries(rootDir: string): RoundListEntry[] {
  const kinds: RoundKind[] = ["overnight", "develop"];
  const out: RoundListEntry[] = [];

  for (const kind of kinds) {
    for (const candidate of listSessionCandidates(rootDir, kind)) {
      let raw: string;
      try {
        raw = readFileSync(candidate.planPath, "utf8");
      } catch {
        continue; // plan.json sumiu entre o listSessionCandidates e agora — pula
      }
      let plan: RawPlan;
      try {
        plan = JSON.parse(raw) as RawPlan;
      } catch {
        continue; // corrompido — omite da lista, best-effort
      }
      const issues = Array.isArray(plan.issues) ? plan.issues : [];
      const counts: Record<string, number> = {};
      for (const issue of issues) {
        const status = typeof issue.status === "string" ? issue.status : "unknown";
        counts[status] = (counts[status] ?? 0) + 1;
      }
      const { iso: startedAt, source: startedAtSource } = resolveStartedAt(
        plan.started_at,
        candidate.mtimeMs,
      );
      out.push({
        kind,
        sessionId: candidate.dir,
        planPath: toRelativeRoot(rootDir, candidate.planPath),
        startedAt,
        startedAtSource,
        updatedAt: new Date(candidate.mtimeMs).toISOString(),
        totalIssues: issues.length,
        counts,
      });
    }
  }

  out.sort((a, b) => {
    const diff = new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
    if (diff !== 0) return diff;
    // Desempate determinístico (mesmo mtime/started_at — raro): nome do
    // diretório desc., mesma heurística secundária de `findLatestPlanPath`.
    return a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0;
  });

  return out;
}
