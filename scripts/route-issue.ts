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
 * `--reason` é **obrigatório** pra `--track bloqueada` e `--track agendada`
 * (#7270/#7288 — bloqueio/agendamento sem motivo registrado é o padrão que
 * as duas issues corrigiram); opcional pros demais tracks. `--until` só é
 * aceito (e exigido) com `--track agendada`.
 *
 * ## `--track bloqueada` grava o marcador `bloqueio-execucao` (#7270)
 *
 * Toda vez que `--track bloqueada` roteia com sucesso, o comentário
 * embute automaticamente `formatExecutionBlockMarker` (`scripts/lib/
 * issue-decisions.ts`) — motivo (`--reason`) + condição de desbloqueio.
 * Duas formas de condição:
 *
 *   - `--depends-on N` — a issue só desbloqueia quando #N fechar. Exige que
 *     o marcador `<!-- depends-on: #N -->` (#7137) já esteja no CORPO da
 *     issue; aplica a label `dependencia-aberta` (não a genérica
 *     `bloqueio-execucao`) a menos que `--motivo` diga outra coisa.
 *   - sem `--depends-on` — condição `externo` (texto de `--reason`), o
 *     único caso que exige revisão humana periódica (ver
 *     `scripts/route-marker-staleness-alarm.ts`).
 *
 * `--sessao {continuo|overnight|develop}` grava em `ExecutionBlock.sessao`
 * (metadado informativo; default `"overnight"` quando omitido).
 *
 * ## `--track agendada` recusa razão que não é data (#7288 Parte A)
 *
 * `--reason` é validado contra 3 padrões de "isto não é uma data" (citação
 * de dependência, gatilho condicional, tamanho de escopo — ver
 * `scripts/lib/route-reason-guard.ts`); recusa nomeando o mecanismo certo.
 * `--force` bypassa só essa checagem de padrão (nunca o motivo em branco).
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
 *   --track bloqueada:     conta-de-terceiro, plataforma, kit, execucao,
 *                          not-this-week, next-month (#6272 — as duas
 *                          últimas gravam automaticamente um marcador
 *                          `aguardando-ate:` D+7/D+30, ver docstring de
 *                          `VAGUE_DEFERRAL_AUTO_DEFER_DAYS` em `issue-route.ts`)
 *   --track epica:          epica (default sem --motivo — ver `TRACK_ADD_LABEL`)
 *   --track fora-de-rodada: sem-direcao, decisao, alarme-estado
 *   --track overnight:     alarme-evento
 *
 * ## 3b — preservação de label específica (#6197)
 *
 * Roteando pra `bloqueada` sem `--motivo`, se a issue já carrega uma label
 * de `BLOCKED_LABELS` (ex: `external-blocker`), ela é PRESERVADA em vez
 * de ser substituída por `bloqueio-execucao`.
 *
 * ## `--for-create` (#6205 — declarar o track NA CRIAÇÃO da issue)
 *
 * Modo alternativo, sem nenhuma chamada `gh`: a issue ainda não existe, não
 * há estado anterior pra ler/diffar/validar. Devolve só `{ labels, body }`
 * — o CALLER usa em `gh issue create --label {labels} --body {body} ...`
 * (título e o resto do corpo continuam por conta do caller; `body` aqui só
 * carrega o marcador `aguardando-ate:` quando `--track agendada`).
 *
 *   npx tsx scripts/route-issue.ts --for-create --track develop \
 *     --motivo conta-de-terceiro
 *   # { "ok": true, "labels": ["external-blocker"], "body": "" }
 *
 *   npx tsx scripts/route-issue.ts --for-create --track agendada \
 *     --until 2026-09-01 --body "corpo original da issue"
 *   # { "ok": true, "labels": [], "body": "<!-- aguardando-ate: 2026-09-01 -->\n\ncorpo original da issue" }
 *
 * Sem sinal conhecido do track na criação, não chamar `--for-create` —
 * a issue nasce sem nenhuma label de track (default `overnight` implícito
 * de `classifyExecTrack`), e o SKILL.md que criou a issue deve deixar isso
 * "·sem sinal" explícito no comentário/corpo em vez de fingir que sabia.
 */
import { spawnGhSync, type GhSpawnResult } from "./lib/shared/gh-run.ts";
import { isMainModule } from "./lib/cli-args.ts";
import {
  autoMotivoForTrack,
  diffRouteLabelPlan,
  formatRouteIssueMarker,
  labelsForNewIssue,
  MOTIVO_LABEL,
  planRouteLabels,
  ROUTE_TRACKS,
  VAGUE_DEFERRAL_AUTO_DEFER_DAYS,
  type RouteMotivo,
  type RouteTrack,
} from "./lib/issue-route.ts";
import { classifyExecTrack } from "./lib/issue-exec-track.ts";
import {
  clearWaitUntilMarkerOnIssue,
  computeWaitUntilMarkerDate,
  syncWaitUntilMarkerOnIssue,
  upsertWaitUntilMarker,
} from "./lib/wait-until-sync.ts";
import { formatExecutionBlockMarker, type SessionKind } from "./lib/issue-decisions.ts";
import { parseDependsOn } from "./lib/issue-depends-on.ts";
import { detectNonDateReason, type NonDateReasonFinding } from "./lib/route-reason-guard.ts";

export type GhRunFn = (args: string[], cwd: string) => GhSpawnResult;

export interface RouteIssueOptions {
  issue: number;
  track: RouteTrack;
  /** Obrigatório para `track === "bloqueada"` e `track === "agendada"` desde
   * #7270/#7288 — ver docstring de `routeIssue`. Continua opcional pros
   * demais tracks (comportamento pré-existente). */
  reason?: string;
  /** `--motivo` estruturado (#6197 item 2) — seleciona a label específica
   * do veredito em vez da genérica. Opcional; quando ausente, `routeIssue`
   * tenta auto-derivar de labels já presentes (#6197 item 3b) e só então
   * recorre ao default genérico de `TRACK_ADD_LABEL`. */
  motivo?: RouteMotivo;
  /** ISO date/datetime (`AAAA-MM-DD` ou `AAAA-MM-DDTHH:mm:ssZ`) — só válido
   * (e obrigatório) com `track === "agendada"`. */
  until?: string;
  /** #7270 — só válido com `track === "bloqueada"`. Número da issue da qual
   * ESTA depende — declara `condicao: {tipo: "depends_on"}` no marcador
   * `bloqueio-execucao` embutido no comentário. Exige que o marcador
   * `<!-- depends-on: #N -->` (#7137) já exista no CORPO da issue — este
   * verbo não o escreve, só valida a presença (o marcador é a fonte que
   * `scripts/reconcile-issue-dependencies.ts` consulta pra desarmar
   * sozinho; duplicar essa escrita aqui criaria 2 pontos de verdade). Sem
   * `--depends-on`, a condição gravada é `externo` (ver docstring abaixo). */
  dependsOn?: number;
  /** Qual sessão está roteando — grava em `ExecutionBlock.sessao` quando
   * `track === "bloqueada"`. Opcional; default `"overnight"` quando ausente
   * (metadado informativo pro alarme de revisão periódica — nunca afeta
   * classificação, só atribuição em relatório). */
  sessao?: SessionKind;
  /** #7288 Parte A — escape hatch pro falso positivo do detector de padrão
   * não-data em `--track agendada --reason`. NÃO dispensa `--reason`
   * (motivo vazio continua recusado incondicionalmente) — só bypassa a
   * recusa por PADRÃO de texto (fatia de escopo, dependência, gatilho
   * condicional). */
  force?: boolean;
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

function buildCommentBody(
  track: RouteTrack,
  reason: string | undefined,
  autoDeferUntilYmd?: string,
  executionBlockMarker?: string,
): string {
  const marker = formatRouteIssueMarker(track);
  const lines = [marker, "", `Roteado para **${track}**${reason ? ` — ${reason}` : "."}`];
  // #6272 — deferimento vago (not-this-week/next-month) pareado com marcador
  // aguardando-ate: auto-computado. Registrar a data no próprio comentário
  // (não só no marcador do corpo) pra quem lê o histórico da issue não
  // precisar abrir o corpo pra saber quando ela reaparece na fila.
  if (autoDeferUntilYmd) {
    lines.push(
      "",
      `Marcador \`aguardando-ate: ${autoDeferUntilYmd}\` gravado automaticamente — a issue reaparece na fila nessa data sem ação manual (#6272).`,
    );
  }
  // #7270 — `track === "bloqueada"` embute o marcador `bloqueio-execucao`
  // NO MESMO comentário, em vez de depender de uma sessão lembrar de
  // postá-lo como passo SEPARADO (era exatamente esse 2º passo manual que
  // 9 de 12 bloqueadas nunca receberam). Uma única chamada a `routeIssue`
  // agora produz os dois marcadores — não há mais um caminho de escrita que
  // aplique a label sem o motivo/condição de desbloqueio.
  if (executionBlockMarker) {
    lines.push("", executionBlockMarker);
  }
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
  if (options.dependsOn !== undefined && track !== "bloqueada") {
    return failResult(`--depends-on só é aceito com --track bloqueada (recebido --track ${track}).`);
  }

  // #7270/#7288 — `--reason` passa a ser OBRIGATÓRIO pros dois vereditos que
  // ficam invisíveis pra sempre sem ele: `bloqueada` sem motivo registrado é
  // exatamente o que a auditoria do #7270 mediu (9 de 12 issues bloqueadas
  // sem NENHUM marcador); `agendada` sem razão é o que permitiu o #7288
  // acontecer sem nem precisar de um padrão de texto ruim — motivo em
  // branco já era 1 dos 11 casos medidos (#6674). Os demais tracks
  // continuam com `--reason` opcional (comportamento pré-existente).
  const reasonTrimmed = (reason ?? "").trim();
  if ((track === "bloqueada" || track === "agendada") && reasonTrimmed.length === 0) {
    return failResult(
      `--track ${track} exige --reason não-vazio — bloqueio/agendamento sem motivo registrado é o padrão que #7270/#7288 corrigiram.`,
    );
  }

  // #7288 Parte A — `--track agendada` recusa razão que na verdade descreve
  // dependência de outra issue, gatilho condicional sem data, ou tamanho de
  // escopo (os 3 padrões que a auditoria do #7288 mediu em 10 dos 11 casos
  // de "agendada" que eram estacionamento disfarçado). `--force` (escape
  // hatch) bypassa só esta checagem de PADRÃO — nunca o motivo em branco
  // acima, que não tem override possível (não há texto pra "forçar").
  if (track === "agendada" && !options.force) {
    const finding: NonDateReasonFinding | null = detectNonDateReason(reasonTrimmed);
    if (finding) {
      return failResult(
        `--track agendada recusado: ${finding.message} (categoria "${finding.category}"; use --force pra sobrepor se isto for falso positivo).`,
      );
    }
  }

  const fetchedBefore = fetchIssueState(issue, cwd, ghRun);
  if (!fetchedBefore.ok) {
    return failResult(`falha ao ler estado da issue #${issue}: ${fetchedBefore.error}`);
  }

  // #7270 — `--depends-on N` exige que o marcador `<!-- depends-on: #N -->`
  // (#7137) já esteja no CORPO da issue: este verbo não o escreve (evitaria
  // 2 pontos de verdade com `scripts/reconcile-issue-dependencies.ts`, que é
  // quem de fato consulta o marcador pra desarmar o bloqueio sozinho quando
  // #N fecha) — só valida que a condição declarada é real antes de gravar
  // o marcador `bloqueio-execucao` com `condicao: {tipo: "depends_on"}`.
  if (options.dependsOn !== undefined) {
    const declared = parseDependsOn(fetchedBefore.data.body, issue);
    if (!declared.includes(options.dependsOn)) {
      return failResult(
        `--depends-on ${options.dependsOn} exige o marcador "<!-- depends-on: #${options.dependsOn} -->" já presente no corpo da issue #${issue} (#7137) — adicione-o antes de rotear.`,
      );
    }
  }

  // Resolve `--motivo`: explícito > dependência (#7270, se --depends-on foi
  // passado) > auto-derivado (#6197 3b) > undefined (genérico).
  const motivo =
    options.motivo ??
    (options.dependsOn !== undefined ? ("dependencia" as RouteMotivo) : undefined) ??
    autoMotivoForTrack(track, fetchedBefore.data.labels);

  // #6272 — deferimento vago (`not-this-week`/`next-month`) é pareado com um
  // marcador `aguardando-ate:` auto-computado (`now + N dias`, ver
  // `VAGUE_DEFERRAL_AUTO_DEFER_DAYS`) pra nunca ficar sem mecanismo de
  // retorno. `undefined` pra qualquer outro track/motivo — comportamento
  // idêntico ao anterior à #6272.
  const vagueDeferralDays =
    track === "bloqueada" && motivo ? VAGUE_DEFERRAL_AUTO_DEFER_DAYS[motivo] : undefined;
  const vagueDeferralUntilIso =
    vagueDeferralDays !== undefined
      ? new Date(now.getTime() + vagueDeferralDays * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

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

  // Passo 2 — marcador `aguardando-ate:`: `agendada` grava a data pedida;
  // deferimento vago (#6272) grava a data auto-computada; qualquer outro
  // track remove um marcador pré-existente (ver docstring do módulo pro
  // porquê — precedência de classifyExecTrack).
  let markerAction: MarkerAction;
  if (track === "agendada") {
    const syncResult = syncWaitUntilMarkerOnIssue(issue, until as string, cwd, ghRun);
    if (!syncResult.ok) {
      return failResult(`falha ao sincronizar marcador aguardando-ate na issue #${issue}: ${syncResult.error}`);
    }
    markerAction = syncResult.action;
  } else if (vagueDeferralUntilIso) {
    const syncResult = syncWaitUntilMarkerOnIssue(issue, vagueDeferralUntilIso, cwd, ghRun);
    if (!syncResult.ok) {
      return failResult(
        `falha ao sincronizar marcador aguardando-ate (deferimento vago, #6272) na issue #${issue}: ${syncResult.error}`,
      );
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
  const autoDeferUntilYmd = vagueDeferralUntilIso ? vagueDeferralUntilIso.slice(0, 10) : undefined;
  // #7270 — `track === "bloqueada"` sempre embute o marcador
  // `bloqueio-execucao` (motivo + condição de desbloqueio) no MESMO
  // comentário do roteamento — ver docstring de `buildCommentBody`.
  // `reasonTrimmed` está garantido não-vazio pela validação acima (só chega
  // aqui quando `track === "bloqueada"`). `recorded_at` trunca pra
  // granularidade de DIA (`AAAA-MM-DD`, não o timestamp completo) — um
  // timestamp com segundos tornaria CADA chamada de `routeIssue` (mesmo com
  // veredito+razão idênticos, ex: retry dentro da mesma sessão) produzir um
  // comentário levemente diferente, quebrando o dedup do Passo 3 abaixo
  // (`alreadyPosted` compara o corpo inteiro) — regressão pega ao vivo pelo
  // teste "dedup: rodar o mesmo veredito+razão duas vezes" já existente.
  // Granularidade de dia ainda é suficiente pro alarme de revisão periódica
  // (#7270 Parte 2, `scripts/lib/route-marker-staleness.ts`), que mede
  // "sem atualização há N DIAS", nunca horas.
  const executionBlockMarker =
    track === "bloqueada"
      ? formatExecutionBlockMarker({
          recorded_at: now.toISOString().slice(0, 10),
          motivo: reasonTrimmed,
          sessao: options.sessao ?? "overnight",
          condicao:
            options.dependsOn !== undefined
              ? { tipo: "depends_on", issue: options.dependsOn }
              : { tipo: "externo", descricao: reasonTrimmed },
        })
      : undefined;
  const commentBody = buildCommentBody(track, reason, autoDeferUntilYmd, executionBlockMarker);
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
  // #6272 — deferimento vago com marcador auto-computado resolve `agendada`
  // (não `bloqueada`): `classifyExecTrack` checa o marcador futuro ANTES do
  // deferimento vago na ordem de precedência (passo 4 < passo 5 da
  // docstring de `classifyExecTrackWithRule`). Isso é o comportamento
  // CORRETO, não um efeito colateral a esconder — é o mesmo motivo pelo qual
  // `backlog-reconcile.ts` (padrão 1, #6198) considera essa coexistência uma
  // "contradição resolvível": o marcador é o sinal mais específico e vence.
  const expectedTrack = vagueDeferralUntilIso ? "agendada" : track;
  if (resolvedTrack !== expectedTrack) {
    return {
      ok: false,
      labelsAdded: toAdd,
      labelsRemoved: toRemove,
      markerAction,
      commentAction,
      validated: false,
      resolvedTrack,
      error:
        `validação pós-escrita falhou na issue #${issue}: pedido --track ${track}` +
        (vagueDeferralUntilIso ? ` (esperado "${expectedTrack}" por #6272, deferimento vago com marcador)` : "") +
        `, mas classifyExecTrack devolveu "${resolvedTrack}" com o estado final ` +
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

// ─── `--for-create` (#6205) ─────────────────────────────────────────────

export interface ForCreateOptions {
  track: RouteTrack;
  motivo?: RouteMotivo;
  /** Só válido (e obrigatório) com `track === "agendada"` — mesmo contrato
   * de `RouteIssueOptions.until`. */
  until?: string;
  /** Corpo pretendido da issue nova — só usado (e só relevante) quando
   * `track === "agendada"`, pra inserir o marcador `aguardando-ate:` no
   * lugar certo. Omitido/vazio → marcador sozinho vira o corpo inteiro. */
  body?: string;
}

export interface ForCreateResult {
  ok: boolean;
  /** Labels a passar em `gh issue create --label {labels.join(",")}` —
   * vazio é um resultado válido (ex: `--track overnight`, o default sem
   * nenhuma label especial). */
  labels: readonly string[];
  /** Corpo com o marcador `aguardando-ate:` já inserido, quando
   * `track === "agendada"`; senão o `body` recebido sem alteração (`""` se
   * omitido). */
  body: string;
  error?: string;
}

/**
 * Versão "declarar na criação" de `routeIssue` (#6205) — nenhuma chamada
 * `gh`, porque a issue ainda não existe: não há o que ler/validar
 * pós-escrita (o passo 4 de `routeIssue` não se aplica). Devolve só o que
 * o CALLER precisa passar pra `gh issue create` (`labels` via `--label`,
 * `body` já com o marcador inserido se aplicável) — o CALLER ainda monta
 * `--title`/`--body` normalmente, isto não invoca `gh issue create` por
 * conta própria (mesmo motivo de `ensureAlarmIssue`/
 * `createAlarmIssueWithLabelRetry` não estarem aqui: retry de label ausente
 * no repo é um problema de "criar issue via gh", ortogonal a "que labels
 * este veredito implica" — caller que precisar do self-heal de label
 * ausente compõe com `scripts/lib/alarm-issues.ts` separadamente).
 */
export function routeIssueForCreate(options: ForCreateOptions): ForCreateResult {
  if (options.motivo && !(options.motivo in MOTIVO_LABEL)) {
    return { ok: false, labels: [], body: options.body ?? "", error: `--motivo desconhecido: "${options.motivo}". Válidos: ${Object.keys(MOTIVO_LABEL).join(", ")}` };
  }
  if (options.track === "agendada" && !options.until) {
    return { ok: false, labels: [], body: options.body ?? "", error: `--track agendada exige --until AAAA-MM-DD.` };
  }
  if (options.track !== "agendada" && options.until) {
    return { ok: false, labels: [], body: options.body ?? "", error: `--until só é aceito com --track agendada (recebido --track ${options.track}).` };
  }
  const labels = labelsForNewIssue(options.track, options.motivo);
  if (options.track !== "agendada") {
    return { ok: true, labels, body: options.body ?? "" };
  }
  const ymd = computeWaitUntilMarkerDate(options.until as string);
  return { ok: true, labels, body: upsertWaitUntilMarker(options.body, ymd) };
}

// ─── CLI ─────────────────────────────────────────────────────────────────

interface ParsedArgs {
  forCreate: boolean;
  issue?: number;
  track?: string;
  reason?: string;
  motivo?: string;
  until?: string;
  body?: string;
  /** #7270 — `--depends-on N` pra `--track bloqueada` (condição de
   * desbloqueio `depends_on`). */
  dependsOn?: string;
  /** #7270 — sessão que está roteando, grava em `ExecutionBlock.sessao`. */
  sessao?: string;
  /** #7288 Parte A — escape hatch pro detector de padrão não-data. */
  force?: boolean;
}

function parseRawArgs(argv: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = { forCreate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--for-create") out.forCreate = true;
    else if (a === "--issue") out.issue = Number(argv[++i]);
    else if (a === "--track") out.track = argv[++i];
    else if (a === "--reason") out.reason = argv[++i];
    else if (a === "--motivo") out.motivo = argv[++i];
    else if (a === "--until") out.until = argv[++i];
    else if (a === "--body") out.body = argv[++i];
    else if (a === "--depends-on") out.dependsOn = argv[++i];
    else if (a === "--sessao") out.sessao = argv[++i];
    else if (a === "--force") out.force = true;
    else return { error: `argumento desconhecido: ${a}` };
  }
  return out;
}

function parseArgs(argv: string[]): RouteIssueOptions | { error: string } {
  const raw = parseRawArgs(argv);
  if ("error" in raw) return raw;
  const { issue, track, reason, motivo } = raw;
  if (!issue || !Number.isInteger(issue) || issue <= 0) {
    return { error: `--issue N (inteiro positivo) é obrigatório` };
  }
  if (!track || !(ROUTE_TRACKS as string[]).includes(track)) {
    return { error: `--track é obrigatório, um de: ${ROUTE_TRACKS.join(", ")}` };
  }
  if (motivo && !(motivo in MOTIVO_LABEL)) {
    return { error: `--motivo desconhecido: "${motivo}". Válidos: ${Object.keys(MOTIVO_LABEL).join(", ")}` };
  }
  let dependsOn: number | undefined;
  if (raw.dependsOn !== undefined) {
    dependsOn = Number(raw.dependsOn.replace(/^#/, ""));
    if (!Number.isInteger(dependsOn) || dependsOn <= 0) {
      return { error: `--depends-on inválido: "${raw.dependsOn}" (esperado um número de issue positivo)` };
    }
  }
  if (raw.sessao && raw.sessao !== "continuo" && raw.sessao !== "overnight" && raw.sessao !== "develop") {
    return { error: `--sessao inválido: "${raw.sessao}". Válidos: continuo, overnight, develop` };
  }
  return {
    issue,
    track: track as RouteTrack,
    reason,
    motivo: motivo as RouteMotivo | undefined,
    until: raw.until,
    dependsOn,
    sessao: raw.sessao as SessionKind | undefined,
    force: raw.force,
    cwd: process.cwd(),
  };
}

function parseForCreateArgs(argv: string[]): ForCreateOptions | { error: string } {
  const raw = parseRawArgs(argv);
  if ("error" in raw) return raw;
  const { track, motivo, until, body } = raw;
  if (!track || !(ROUTE_TRACKS as string[]).includes(track)) {
    return { error: `--track é obrigatório, um de: ${ROUTE_TRACKS.join(", ")}` };
  }
  return { track: track as RouteTrack, motivo: motivo as RouteMotivo | undefined, until, body };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--for-create")) {
    const parsed = parseForCreateArgs(argv);
    if ("error" in parsed) {
      console.error(`[route-issue] ${parsed.error}`);
      process.exitCode = 1;
      return;
    }
    const result = routeIssueForCreate(parsed);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`[route-issue] ${result.error ?? "falhou sem mensagem de erro"}`);
      process.exitCode = 1;
    }
    return;
  }

  const parsed = parseArgs(argv);
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
