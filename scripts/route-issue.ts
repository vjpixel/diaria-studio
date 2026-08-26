#!/usr/bin/env -S npx tsx
/**
 * scripts/route-issue.ts (#5969 Fase 1 — "Verbo único de roteamento")
 *
 * Uma chamada, um veredito. Substitui a instrução em prosa espalhada pelas
 * SKILLs ("aplicar label X + comentar Y") — cada julgamento feito sem o
 * passo extra de `gh issue edit --add-label` deixava a issue classificada
 * errado, silenciosamente (RC1 da #5969: 17 issues corretivas em 8 dias,
 * todas o mesmo sintoma por vazamentos diferentes desse write-path frágil).
 *
 * ## O que faz, numa chamada:
 *
 *   1. Aplica e remove o conjunto certo de labels pro veredito pedido
 *      (`planRouteLabels`/`diffRouteLabelPlan` em `scripts/lib/issue-route.ts`
 *      — mapeamento derivado dos MESMOS literais que `classifyExecTrack`
 *      usa, nunca uma lista redigitada à mão).
 *   2. Sincroniza (ou remove) o marcador `aguardando-ate:` no corpo — só
 *      `--track agendada` grava um marcador (exige `--until`); qualquer
 *      outro `--track` REMOVE um marcador pré-existente (idempotente,
 *      no-op se ausente) — sem isso, uma issue que já foi `agendada` e agora
 *      está sendo roteada pra `develop` continuaria classificando `agendada`
 *      em `classifyExecTrack` (marcador vence sobre `develop` na ordem de
 *      precedência), fazendo o passo 4 (validação) falhar sempre.
 *   3. Comenta na issue com dedup — o corpo do comentário carrega um
 *      marcador `<!-- route-issue: track=X -->`; se um comentário
 *      IDÊNTICO (mesmo track + mesma razão) já existe, pula (evita spam ao
 *      re-rodar `route-issue.ts` idempotentemente com o mesmo veredito).
 *   4. Valida: re-busca o estado da issue PÓS-escrita e roda
 *      `classifyExecTrack` de novo. Se o veredito resultante não bater com
 *      `--track`, falha ruidosamente (`process.exitCode = 1` + mensagem
 *      explicando o que foi escrito e o que `classifyExecTrack` devolveu) —
 *      nunca sai em silêncio achando que funcionou.
 *
 * ## Uso
 *
 *   npx tsx scripts/route-issue.ts --issue 1234 --track develop \
 *     --reason "exige a máquina Windows (Chrome logado)"
 *
 *   npx tsx scripts/route-issue.ts --issue 1234 --track agendada \
 *     --until 2026-09-01 --reason "aguardando resposta da Beehiiv"
 *
 * `--reason` é opcional mas fortemente recomendado — vira o corpo legível
 * do comentário; sem ele, o comentário só carrega o marcador + o veredito.
 * `--until` só é aceito (e exigido) com `--track agendada`.
 *
 * ## `--motivo` (#6197 item 2 — label específica vs genérica)
 *
 * `--motivo` substitui a label genérica do veredito pela mais específica.
 * Ex.: `--track bloqueada --motivo conta-de-terceiro` adiciona
 * `external-blocker` (não `bloqueio-execucao`). Sem `--motivo`, o verbo
 * auto-deriva uma label específica se a issue já a carregar (3b) e só então
 * recorre ao default genérico de `TRACK_ADD_LABEL`.
 *
 * Valores válidos (fonte: `MOTIVO_LABEL` em `issue-route.ts`):
 *
 *   --track bloqueada:     conta-de-terceiro, plataforma, kit, execucao
 *   --track fora-de-rodada: epica, sem-direcao, decisao, alarme-estado
 *   --track overnight:     alarme-evento
 *
 * ## 3b — preservação de label específica (#6197)
 *
 * Roteando pra `bloqueada` sem `--motivo`, se a issue já carrega uma label
 * de `BLOCKED_LABELS` (ex: `external-blocker`), ela é PRESERVADA em vez
 * de ser substituída por `bloqueio-execucao`.
 */
import { spawnGhSync, type GhSpawnResult } from "./lib/shared/gh-run.ts";
import { isMainModule } from "./lib/cli-args.ts";
import {
  autoMotivoForTrack,
  diffRouteLabelPlan,
  MOTIVO_LABEL,
  planRouteLabels,
  ROUTE_TRACKS,
  type RouteMotivo,
  type RouteTrack,
} from "./lib/issue-route.ts";
import { classifyExecTrack } from "./lib/issue-exec-track.ts";
import { clearWaitUntilMarkerOnIssue, syncWaitUntilMarkerOnIssue } from "./lib/wait-until-sync.ts";

export type GhRunFn = (args: string[], cwd: string) => GhSpawnResult;

export interface RouteIssueOptions {
  issue: number;
  track: RouteTrack;
  reason?: string;
  /** `--motivo` estruturado (#6197 item 2) — seleciona a label específica
   * do veredito em vez da genérica. Opcional; quando ausente, `routeIssue`
   * tenta auto-derivar de labels já presentes (#6197 item 3b) e só então
   * recorre ao default genérico de `TRACK_ADD_LABEL`. */
  motivo?: RouteMotivo;
  /** ISO date/datetime (`AAAA-MM-DD` ou `AAAA-MM-DDTHH:mm:ssZ`) — só válido
   * (e obrigatório) com `track === "agendada"`. */
  until?: string;
  cwd: string;
  ghRun?: GhRunFn;
  /** Injetável pra teste; default `new Date()`. Usado só na validação final
   * (passo 4) contra `classifyExecTrack`. */
  now?: Date;
}

export type CommentAction = "posted" | "deduped" | "failed" | "skipped";
export type MarkerAction = "inserted" | "updated" | "removed" | "noop" | "failed" | "skipped";

export interface RouteIssueResult {
  ok: boolean;
  labelsAdded: string[];
  labelsRemoved: string[];
  markerAction: MarkerAction;
  commentAction: CommentAction;
  validated: boolean;
  resolvedTrack?: RouteTrack | "fora-de-rodada" | "overnight" | "bloqueada" | "develop" | "agendada";
  error?: string;
}

interface FetchedIssueState {
  labels: string[];
  body: string;
  state: string;
  comments: string[];
}

function fetchIssueState(
  issue: number,
  cwd: string,
  ghRun: GhRunFn,
): { ok: true; data: FetchedIssueState } | { ok: false; error: string } {
  const res = ghRun(["issue", "view", String(issue), "--json", "labels,body,state,comments"], cwd);
  if (res.status !== 0) {
    return { ok: false, error: res.stderr.trim() || `gh issue view falhou (status ${res.status ?? "null"})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    return { ok: false, error: `resposta de "gh issue view" não é JSON válido: ${(e as Error).message}` };
  }
  const obj = parsed as {
    labels?: Array<{ name?: string }>;
    body?: string | null;
    state?: string;
    comments?: Array<{ body?: string }>;
  };
  return {
    ok: true,
    data: {
      labels: (obj.labels ?? []).map((l) => l.name ?? "").filter((n) => n.length > 0),
      body: obj.body ?? "",
      state: obj.state ?? "OPEN",
      comments: (obj.comments ?? []).map((c) => c.body ?? ""),
    },
  };
}

function buildCommentBody(track: RouteTrack, reason: string | undefined): string {
  const marker = `<!-- route-issue: track=${track} -->`;
  const lines = [marker, "", `Roteado para **${track}**${reason ? ` — ${reason}` : "."}`];
  return lines.join("\n");
}

/**
 * Ponto de entrada programático (o CLI abaixo é uma casca fina em cima
 * disto) — separado pra ser testável sem `spawnSync`/rede real, mesmo
 * padrão de dependency injection já usado por `scripts/lib/alarm-issues.ts`
 * e `scripts/lib/wait-until-sync.ts` (`ghRun: GhRunFn` injetável, default
 * `spawnGhSync`).
 */
export function routeIssue(options: RouteIssueOptions): RouteIssueResult {
  const { issue, track, reason, until, cwd, now = new Date() } = options;
  const ghRun = options.ghRun ?? spawnGhSync;

  // Validation antés da I/O: --motivo explícito, e --until só com agendada.
  if (options.motivo && !(options.motivo in MOTIVO_LABEL)) {
    return failResult(`--motivo desconhecido: "${options.motivo}". Válidos: ${Object.keys(MOTIVO_LABEL).join(", ")}`);
  }
  if (track === "agendada" && !until) {
    return failResult(`--track agendada exige --until AAAA-MM-DD (sem data não há como produzir esse vereditado).`);
  }
  if (track !== "agendada" && until) {
    return failResult(`--until só é aceito com --track agendada (recebido --track ${track}).`);
  }

  const fetchedBefore = fetchIssueState(issue, cwd, ghRun);
  if (!fetchedBefore.ok) {
    return failResult(`falha ao ler estado da issue #${issue}: ${fetchedBefore.error}`);
  }

  // Resolve `--motivo`: explícito > auto-derivado (#6197 3b) > undefined (genérico).
  const motivo = options.motivo ?? autoMotivoForTrack(track, fetchedBefore.data.labels);

  // Passo 1 — labels: aplica e remove o conjunto certo pro veredito.
  const plan = planRouteLabels(track, motivo);
  const { toAdd, toRemove } = diffRouteLabelPlan(fetchedBefore.data.labels, plan);
  if (toAdd.length > 0 || toRemove.length > 0) {
    const args = ["issue", "edit", String(issue)];
    if (toAdd.length > 0) args.push("--add-label", toAdd.join(","));
    if (toRemove.length > 0) args.push("--remove-label", toRemove.join(","));
    const res = ghRun(args, cwd);
    if (res.status !== 0) {
      return failResult(`falha ao editar labels da issue #${issue}: ${res.stderr.trim() || "gh issue edit falhou"}`);
    }
  }

  // Passo 2 — marcador `aguardando-ate:`: só `agendada` grava; qualquer
  // outro track remove um marcador pré-existente (ver docstring do módulo
  // pro porquê — precedência de classifyExecTrack).
  let markerAction: MarkerAction;
  if (track === "agendada") {
    const syncResult = syncWaitUntilMarkerOnIssue(issue, until as string, cwd, ghRun);
    if (!syncResult.ok) {
      return failResult(`falha ao sincronizar marcador aguardando-ate na issue #${issue}: ${syncResult.error}`);
    }
    markerAction = syncResult.action;
  } else {
    const clearResult = clearWaitUntilMarkerOnIssue(issue, cwd, ghRun);
    if (!clearResult.ok) {
      return failResult(`falha ao limpar marcador aguardando-ate da issue #${issue}: ${clearResult.error}`);
    }
    markerAction = clearResult.action;
  }

  // Passo 3 — comentário com dedup.
  const commentBody = buildCommentBody(track, reason);
  let commentAction: CommentAction;
  const alreadyPosted = fetchedBefore.data.comments.some((c) => c.trim() === commentBody.trim());
  if (alreadyPosted) {
    commentAction = "deduped";
  } else {
    const res = ghRun(["issue", "comment", String(issue), "--body", commentBody], cwd);
    if (res.status !== 0) {
      // Comentário é auditoria/rastro — falha aqui não deve mascarar que
      // labels/marcador já foram escritos com sucesso, mas também não deve
      // ser engolida em silêncio. Reporta como resultado não-ok (o caller
      // decide a severidade), sem reverter as escritas anteriores.
      return {
        ok: false,
        labelsAdded: toAdd,
        labelsRemoved: toRemove,
        markerAction,
        commentAction: "failed",
        validated: false,
        error: `falha ao comentar na issue #${issue}: ${res.stderr.trim() || "gh issue comment falhou"}`,
      };
    }
    commentAction = "posted";
  }

  // Passo 4 — validação: re-busca e roda classifyExecTrack de novo.
  const fetchedAfter = fetchIssueState(issue, cwd, ghRun);
  if (!fetchedAfter.ok) {
    return {
      ok: false,
      labelsAdded: toAdd,
      labelsRemoved: toRemove,
      markerAction,
      commentAction,
      validated: false,
      error: `falha ao reler estado da issue #${issue} pra validação: ${fetchedAfter.error}`,
    };
  }
  const resolvedTrack = classifyExecTrack({
    labels: fetchedAfter.data.labels,
    body: fetchedAfter.data.body,
    state: fetchedAfter.data.state,
    now,
  });
  if (resolvedTrack !== track) {
    return {
      ok: false,
      labelsAdded: toAdd,
      labelsRemoved: toRemove,
      markerAction,
      commentAction,
      validated: false,
      resolvedTrack,
      error:
        `validação pós-escrita falhou na issue #${issue}: pedido --track ${track}, ` +
        `mas classifyExecTrack devolveu "${resolvedTrack}" com o estado final ` +
        `(labels=[${fetchedAfter.data.labels.join(", ")}], state=${fetchedAfter.data.state}). ` +
        `Isso indica um bloqueio mais forte na precedência (ex: state CLOSED, label de ` +
        `BLOCKED_LABELS ainda presente) ou um gap no mapeamento veredito→labels.`,
    };
  }

  return {
    ok: true,
    labelsAdded: toAdd,
    labelsRemoved: toRemove,
    markerAction,
    commentAction,
    validated: true,
    resolvedTrack,
  };
}

function failResult(error: string): RouteIssueResult {
  return {
    ok: false,
    labelsAdded: [],
    labelsRemoved: [],
    markerAction: "skipped",
    commentAction: "skipped",
    validated: false,
    error,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): RouteIssueOptions | { error: string } {
  let issue: number | undefined;
  let track: string | undefined;
  let reason: string | undefined;
  let motivo: string | undefined;
  let until: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--issue") issue = Number(argv[++i]);
    else if (a === "--track") track = argv[++i];
    else if (a === "--reason") reason = argv[++i];
    else if (a === "--motivo") motivo = argv[++i];
    else if (a === "--until") until = argv[++i];
    else return { error: `argumento desconhecido: ${a}` };
  }
  if (!issue || !Number.isInteger(issue) || issue <= 0) {
    return { error: `--issue N (inteiro positivo) é obrigatório` };
  }
  if (!track || !(ROUTE_TRACKS as string[]).includes(track)) {
    return { error: `--track é obrigatório, um de: ${ROUTE_TRACKS.join(", ")}` };
  }
  if (motivo && !(motivo in MOTIVO_LABEL)) {
    return { error: `--motivo desconhecido: "${motivo}". Válidos: ${Object.keys(MOTIVO_LABEL).join(", ")}` };
  }
  return { issue, track: track as RouteTrack, reason, motivo: motivo as RouteMotivo | undefined, until, cwd: process.cwd() };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`[route-issue] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }
  const result = routeIssue(parsed);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`[route-issue] ${result.error ?? "falhou sem mensagem de erro"}`);
    process.exitCode = 1;
  }
}

// `isMainModule` (e não a comparação crua `import.meta.url === "file://" +
// process.argv[1]`) porque a forma crua NUNCA casa no Windows: `argv[1]` vem
// como `C:\...\route-issue.ts` e `import.meta.url` como `file:///C:/...`.
// O efeito era o pior possível pra um verbo de escrita — `main()` nunca
// rodava, o processo saía 0 sem imprimir nada, e quem chamou lia "sucesso"
// (medido ao vivo em 26/08/2026 na máquina do editor: nenhuma label mudou,
// nenhum comentário postado, exit 0). `isMainModule` normaliza via
// `fileURLToPath`, que é o caminho já usado por ~478 scripts deste repo.
if (isMainModule(import.meta.url)) {
  main();
}
