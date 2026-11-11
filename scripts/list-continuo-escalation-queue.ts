#!/usr/bin/env npx tsx
/**
 * Fila do briefing com as escaladas do contínuo (#12684) + prazo de validade
 * da escalada (#12765). Falha é explícita, nunca uma fila vazia.
 *
 * Cada PR com `continuo-escalado` há mais de 24h entra em `queue`. Passadas
 * 48h, a escalada deixa de ser "pendência do editor" sem prazo e recebe um
 * DESTINO determinístico (`escalationDestination`):
 *
 *   - `fechar-redundante`   — tudo que a PR muda já está igual no master
 *                             (resgate órfão cujo conteúdo entrou por outro caminho);
 *   - `fechar-para-issue`   — draft com `bloqueio-execucao`: o bloqueio vive na
 *                             issue, não na lista de PRs; a branch fica;
 *   - `fixer`               — conflito com o master, CI que não fecha
 *                             (fail/pending) ou draft sem bloqueio, sem
 *                             tentativa anterior de nenhum fixer: o coordenador
 *                             despacha `dev-fixer` (rebase + CI; draft verde é
 *                             marcado ready) e marca a PR com
 *                             `mark-continuo-ci-fix-attempted.ts`;
 *   - `fechar-reabrir-issue`— conflito/CI parado AGORA com `continuo-ci-fix-tentado`
 *                             já presente (a label também vem do loop do
 *                             contínuo): devolve a issue para a fila e fecha a
 *                             PR. Sem issue de origem identificável, `briefing`.
 *                             CI `pending` só fecha se a label de tentativa tem
 *                             mais de 6h (`PENDING_AFTER_FIX_MS`, #12804): antes
 *                             disso o CI do conserto ainda pode estar na fila;
 *                             `error` (checks ilegíveis) nunca fecha nem vai ao
 *                             fixer — é `briefing` (fail-closed, #12804);
 *   - `briefing`            — o resto (diff grande, caminho sensível, sem
 *                             veredito), e sempre que a PR está retida para o
 *                             editor (#10278) ou reivindicada por sessão viva:
 *                             decisão do editor.
 *
 * Sem `--apply` o script não escreve no GitHub; o `git fetch` da checagem de
 * redundância grava só em `refs/escalation-check/*` (`--refmap=` desliga a
 * atualização oportunista de `refs/remotes/origin/*`).
 *
 * `--apply` executa os três destinos `fechar-*` (fechar PR é reversível:
 * `gh pr reopen`; a branch nunca é apagada). Ordem por PR: primeiro a issue
 * (comentário/reabertura), por último o `pr close` — falha no meio deixa a PR
 * aberta e a próxima rodada a vê de novo. Falha de uma PR não interrompe as
 * outras: vai para `failures[]` e o script sai 1 no fim. `fixer` e
 * `briefing` precisam de agente/editor e ficam com o coordenador.
 *
 * Uso: npx tsx scripts/list-continuo-escalation-queue.ts [--apply]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { isMainModule } from "./lib/cli-args.ts";
import { extractClosingIssueNumbers } from "./lib/continuo-superseded-check.ts";

const REPO = "vjpixel/diaria-studio";
const ESCALATION_LABEL = "continuo-escalado";
const HOUR_MS = 60 * 60 * 1000;
export const ESCALATION_QUEUE_AFTER_MS = 24 * HOUR_MS;
export const ESCALATION_EXPIRY_MS = 48 * HOUR_MS;
/**
 * CI `pending` depois do fixer só conta como parado quando a tentativa
 * (`continuo-ci-fix-tentado`) tem mais que isto (#12804): a fila de runners
 * lenta (#10578) deixa o CI do conserto `pending` por horas.
 */
export const PENDING_AFTER_FIX_MS = 6 * HOUR_MS;
const FIX_TRIED_LABEL = "continuo-ci-fix-tentado";

type LabelEvent = { event: string; label?: { name: string }; created_at: string };

/** Pure: desde quando `label` está aplicada (último `labeled` sem `unlabeled` depois). */
export function labelSince(events: LabelEvent[], label: string): string | null {
  let since: string | null = null;
  for (const event of events) {
    if (event.label?.name !== label) continue;
    if (event.event === "labeled") since = event.created_at;
    if (event.event === "unlabeled") since = null;
  }
  return since;
}

/** Pure: desde quando a escalada corrente está aberta. */
export function escalationSince(events: LabelEvent[]): string | null {
  return labelSince(events, ESCALATION_LABEL);
}

export function overdueEscalation(events: LabelEvent[], now: number): string | null {
  const since = escalationSince(events);
  return since && now - Date.parse(since) > ESCALATION_QUEUE_AFTER_MS ? since : null;
}

/**
 * Lê todas as páginas de um endpoint de lista do GitHub sem `--slurp` (#12765):
 * o `gh` do servidor 300 (2.46) não suporta a flag e a fila quebrava inteira
 * ali. Para quando uma página vem com menos que `perPage` itens. Teto de
 * páginas para nunca entrar em laço.
 */
export function fetchAllPages<T>(fetchPage: (page: number, perPage: number) => T[], perPage = 100, maxPages = 50): T[] {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = fetchPage(page, perPage);
    if (!Array.isArray(items)) throw new Error(`página ${page} não é array`);
    all.push(...items);
    if (items.length < perPage) return all;
  }
  throw new Error(`limite de ${maxPages} páginas atingido — leitura possivelmente truncada`);
}

export type ClosingDestination = "fechar-redundante" | "fechar-para-issue" | "fechar-reabrir-issue";
export type EscalationDestination = "briefing" | "fixer" | ClosingDestination;

export function isClosingDestination(d: EscalationDestination): d is ClosingDestination {
  return d === "fechar-redundante" || d === "fechar-para-issue" || d === "fechar-reabrir-issue";
}

export interface DestinationInput {
  ageMs: number;
  isDraft: boolean;
  labels: string[];
  mergeStateStatus?: string | null;
  /** `details.mergeable` do gate (`MERGEABLE`/`CONFLICTING`/`UNKNOWN`). */
  mergeable?: string | null;
  /** `details.checksVerdict` do gate — estado ATUAL do CI, não a 1ª razão da escalada. */
  checksVerdict?: string | null;
  /** `details.retidoParaEditor.retido` do gate (#10278); `null` = ilegível. */
  retido: boolean | null;
  /** Outra sessão viva reivindica a PR/issue (`details.sessionClaims.ok === false`). */
  claimed: boolean;
  /** `true` = todo arquivo que a PR muda já está igual no master. Só é calculado depois de 48h. */
  redundant: boolean;
  /** Issue de origem (`originIssue`); sem ela, `fechar-reabrir-issue` não tem para onde devolver. */
  issue: number | null;
  /**
   * Há quanto tempo `continuo-ci-fix-tentado` foi aplicada (eventos da PR).
   * Ausente/`null`/não finito = desconhecido: CI `pending` nunca fecha (#12804).
   */
  fixTriedAgeMs?: number | null;
}

/**
 * Pure: destino da escalada. Antes de 48h (ou idade ilegível) é sempre
 * `briefing` (#12684). PR retida para o editor (#10278, ou retenção ilegível)
 * ou reivindicada por sessão viva nunca recebe destino automático.
 */
export function escalationDestination(input: DestinationInput): EscalationDestination {
  if (!Number.isFinite(input.ageMs) || input.ageMs <= ESCALATION_EXPIRY_MS) return "briefing";
  if (input.retido !== false || input.claimed) return "briefing";
  if (input.redundant) return "fechar-redundante";
  if (input.isDraft && input.labels.includes("bloqueio-execucao")) return "fechar-para-issue";
  const fixTried = input.labels.includes(FIX_TRIED_LABEL);
  const conflict = input.mergeStateStatus === "DIRTY" || input.mergeable === "CONFLICTING";
  // `error` = o gate não leu os checks: dado ausente nunca fecha nem despacha
  // fixer (#12804). Conflito real (lido de outra fonte) segue valendo.
  if (input.checksVerdict === "error" && !conflict) return "briefing";
  const pending = input.checksVerdict === "pending";
  // `pending` passadas 48h também é CI que não fecha sozinho;
  // `blocked_by_conflict` já é o conflito.
  const ciStuck = ["fail", "pending", "blocked_by_conflict"].includes(input.checksVerdict ?? "");
  // Só fecha pelo estado ATUAL: conflito ou CI parado depois de uma tentativa
  // de fixer. A label sozinha não fecha nada.
  if (conflict || ciStuck) {
    if (!fixTried) return "fixer";
    // CI do conserto ainda na fila (#12804): espera a janela antes de fechar.
    if (pending && !conflict) {
      const age = input.fixTriedAgeMs;
      if (typeof age !== "number" || !Number.isFinite(age) || age <= PENDING_AFTER_FIX_MS) return "briefing";
    }
    return input.issue ? "fechar-reabrir-issue" : "briefing";
  }
  // Draft sem bloqueio, CI verde, sem conflito: falta alguém dá-lo por pronto.
  // 1ª vez vai ao fixer (que marca ready se estiver verde); depois, editor.
  if (input.isDraft) return fixTried ? "briefing" : "fixer";
  return "briefing";
}

/**
 * Pure: issue de origem da PR — branch `fix-N`, depois a 1ª issue fechada pelo
 * corpo (`extractClosingIssueNumbers`, o mesmo parser do gate). Nunca o título:
 * `trem(#6300)`/`chore(#7130)` citam a issue do MECANISMO, não a de origem.
 */
export function originIssue(pr: { headRefName: string; body?: string | null }): number | null {
  // Resgate de órfão (#7130) não tem issue de origem própria.
  if (pr.headRefName.startsWith("continuo/rescue-")) return null;
  const branch = /(?:^|\/)fix-(\d+)(?:-|$)/.exec(pr.headRefName);
  if (branch) return Number(branch[1]);
  return extractClosingIssueNumbers(pr.body)[0] ?? null;
}

const CLOSING_WHY: Record<ClosingDestination, string> = {
  "fechar-redundante": "todo arquivo que esta PR altera já está igual no master — nada a mergear",
  "fechar-para-issue": "é draft com `bloqueio-execucao`: o bloqueio fica registrado na issue, não na lista de PRs",
  "fechar-reabrir-issue": "seguiu com conflito ou CI que não fecha depois de uma tentativa de fixer (`continuo-ci-fix-tentado`)",
};

/** Pure: texto do comentário de fechamento. */
export function closingComment(dest: ClosingDestination, pr: { headRefName: string }, since: string, issue: number | null): string {
  return [
    `Fechada pelo prazo de escalada do contínuo (#12765): escalada desde ${since}, mais de 48h sem destino.`,
    "",
    `Motivo: ${CLOSING_WHY[dest]}.`,
    `A branch \`${pr.headRefName}\` foi preservada; \`gh pr reopen\` desfaz.`,
    issue ? `Issue de origem: #${issue}.` : "",
  ].filter(Boolean).join("\n");
}

/** Pure: dono/fila do item conforme o destino (antes era sempre "editor"). */
export function destinationOwner(dest: EscalationDestination): { owner: string; queue: string } {
  if (dest === "briefing") return { owner: "editor", queue: "briefing overnight/develop" };
  if (dest === "fixer") return { owner: "coordenador", queue: "dev-fixer overnight/develop" };
  return { owner: "coordenador", queue: "list-continuo-escalation-queue --apply" };
}

export interface OpenEscalatedPr {
  number: number;
  url: string;
  title: string;
  body: string | null;
  headRefName: string;
  isDraft: boolean;
  mergeStateStatus: string;
  labels: { name: string }[];
}

export interface GateOutput {
  action?: string;
  reason?: string;
  details?: {
    checksVerdict?: string | null;
    mergeable?: string | null;
    retidoParaEditor?: { retido?: boolean | null } | null;
    sessionClaims?: { ok?: boolean } | null;
  };
}

export interface QueueDeps {
  listPrs(): OpenEscalatedPr[];
  events(pr: number): LabelEvent[];
  /** Saída JSON do `check-continuo-merge-gate.ts`. Lança em falha. */
  gate(pr: number): GateOutput;
  /** `true`/`false` = verificado; `null` = não deu para verificar (nunca fecha). */
  redundant(headRefName: string): boolean | null;
  issueState(issue: number): { state: string; stateReason?: string | null };
  reopenIssue(issue: number): void;
  commentIssue(issue: number, body: string): void;
  closePr(pr: number, comment: string): void;
  now(): number;
}

export interface QueueItem {
  number: number;
  url: string;
  since: string;
  owner: string;
  queue: string;
  action?: string;
  reason?: string;
  expired: boolean;
  destination: EscalationDestination;
  issue: number | null;
  redundant_check?: "failed";
}

export interface QueueResult {
  queue: QueueItem[];
  applied: { number: number; destination: ClosingDestination; issue: number | null; reopened?: boolean }[];
  failures: { number: number; step: string; error: string }[];
}

/**
 * Monta a fila e, com `apply`, executa os destinos `fechar-*`. Falha de uma
 * PR fica em `failures` e não interrompe as demais. Só a listagem inicial
 * lança (sem ela não há fila nenhuma para relatar).
 */
export function runEscalationQueue(deps: QueueDeps, apply: boolean): QueueResult {
  const prs = deps.listPrs();
  // Do not silently truncate a large queue.
  if (prs.length >= 1000) throw new Error("fila atingiu limite de paginação");
  const now = deps.now();
  const result: QueueResult = { queue: [], applied: [], failures: [] };
  for (const pr of prs) {
    let step = "events";
    try {
      const events = deps.events(pr.number);
      const since = overdueEscalation(events, now);
      if (!since) continue;
      step = "gate";
      const gate = deps.gate(pr.number);
      const labels = pr.labels.map((l) => l.name);
      const ageMs = now - Date.parse(since);
      const expired = Number.isFinite(ageMs) && ageMs > ESCALATION_EXPIRY_MS;
      const issue = originIssue(pr);
      const fixTriedSince = labelSince(events, FIX_TRIED_LABEL);
      const fixTriedAgeMs = fixTriedSince ? now - Date.parse(fixTriedSince) : null;
      step = "redundant";
      const redundant = expired ? deps.redundant(pr.headRefName) : false;
      const destination = escalationDestination({
        ageMs, isDraft: pr.isDraft, labels, mergeStateStatus: pr.mergeStateStatus,
        mergeable: gate.details?.mergeable, checksVerdict: gate.details?.checksVerdict,
        // Sem o campo, trata como retida (fail-closed): nunca fecha por dado ausente.
        retido: typeof gate.details?.retidoParaEditor?.retido === "boolean" ? gate.details.retidoParaEditor.retido : null,
        claimed: gate.details?.sessionClaims?.ok === false,
        redundant: redundant === true, issue, fixTriedAgeMs,
      });
      result.queue.push({
        number: pr.number, url: pr.url, since, ...destinationOwner(destination),
        action: gate.action, reason: gate.reason, expired, destination, issue,
        ...(redundant === null ? { redundant_check: "failed" as const } : {}),
      });
      if (!apply || !isClosingDestination(destination)) continue;
      // Issue primeiro, PR por último: falha no meio deixa a PR aberta e visível.
      let reopened = false;
      if (destination === "fechar-reabrir-issue" && issue) {
        step = "issue-reopen";
        const st = deps.issueState(issue);
        // Fechada como "não planejada" é decisão de alguém: só comenta, não reabre.
        if (st.state === "CLOSED" && st.stateReason !== "NOT_PLANNED") {
          deps.reopenIssue(issue);
          reopened = true;
        }
        step = "issue-comment";
        deps.commentIssue(issue,
          `PR #${pr.number} fechada pelo prazo de escalada (#12765): seguiu escalada depois de uma tentativa de fixer. Branch preservada: \`${pr.headRefName}\`.${reopened ? " A issue volta para a fila." : ""}`);
      }
      if (destination === "fechar-para-issue" && issue) {
        step = "issue-comment";
        deps.commentIssue(issue,
          `PR #${pr.number} (draft com \`bloqueio-execucao\`) fechada pelo prazo de escalada (#12765). O trabalho segue na branch \`${pr.headRefName}\`; o bloqueio continua nesta issue.`);
      }
      step = "pr-close";
      deps.closePr(pr.number, closingComment(destination, pr, since, issue));
      result.applied.push({ number: pr.number, destination, issue, ...(reopened ? { reopened } : {}) });
    } catch (error) {
      result.failures.push({ number: pr.number, step, error: String(error instanceof Error ? error.message : error) });
    }
  }
  return result;
}

function gh(args: string[]): unknown {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: 60_000 }));
}

function ghRun(args: string[]): void {
  execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * I/O: todo arquivo que a PR muda está igual no master? Busca para um
 * namespace próprio (`refs/escalation-check/*`) para não reescrever
 * `refs/remotes/origin/*` do checkout compartilhado. Diff vazio = `false`
 * (nada a provar; nunca fecha por ausência de evidência). Erro → `null`.
 */
export function isRedundant(headRefName: string, cwd?: string): boolean | null {
  const ns = "refs/escalation-check";
  try {
    execFileSync("git", ["fetch", "-q", "--refmap=", "origin", `+refs/heads/master:${ns}/master`, `+refs/heads/${headRefName}:${ns}/head`], { cwd, timeout: 120_000, stdio: ["ignore", "ignore", "pipe"] });
    // --no-renames: rename a→b listaria só b e esconderia a remoção de a.
    const files = execFileSync("git", ["diff", "--no-renames", "--name-only", `${ns}/master...${ns}/head`], { cwd, encoding: "utf8" })
      .split("\n").filter(Boolean);
    if (files.length === 0) return false;
    const same = spawnSync("git", ["--literal-pathspecs", "diff", "--no-renames", "--quiet", `${ns}/master`, `${ns}/head`, "--", ...files], { cwd });
    if (same.status === 0) return true;
    if (same.status === 1) return false;
    throw new Error(`git diff saiu ${same.status}`);
  } catch (e) {
    console.error(`[list-continuo-escalation-queue] redundância de ${headRefName} não verificada: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

if (isMainModule(import.meta.url)) {
  const apply = process.argv.includes("--apply");
  try {
    const result = runEscalationQueue({
      listPrs: () => gh([
        "pr", "list", "--repo", REPO, "--state", "open", "--label", ESCALATION_LABEL, "--limit", "1000",
        "--json", "number,url,title,body,headRefName,isDraft,mergeStateStatus,labels",
      ]) as OpenEscalatedPr[],
      events: (n) => fetchAllPages((page, perPage) =>
        gh(["api", `repos/${REPO}/issues/${n}/events?per_page=${perPage}&page=${page}`]) as LabelEvent[]),
      gate: (n) => {
        const gate = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-continuo-merge-gate.ts", "--pr", String(n)], { encoding: "utf8", timeout: 180_000 });
        if (gate.error || ![0, 1, 2].includes(gate.status ?? -1)) throw new Error(`gate #${n} falhou: ${gate.stderr || gate.error}`);
        try {
          return JSON.parse(gate.stdout);
        } catch {
          throw new Error(`gate #${n}: saída não é JSON`);
        }
      },
      redundant: (b) => isRedundant(b),
      issueState: (n) => gh(["issue", "view", String(n), "--repo", REPO, "--json", "state,stateReason"]) as { state: string; stateReason?: string },
      reopenIssue: (n) => ghRun(["issue", "reopen", String(n), "--repo", REPO]),
      commentIssue: (n, body) => ghRun(["issue", "comment", String(n), "--repo", REPO, "--body", body]),
      closePr: (n, comment) => ghRun(["pr", "close", String(n), "--repo", REPO, "--comment", comment]),
      now: () => Date.now(),
    }, apply);
    console.log(JSON.stringify(apply ? result : { queue: result.queue, failures: result.failures }));
    if (result.failures.length > 0) {
      for (const f of result.failures) console.error(`[list-continuo-escalation-queue] #${f.number} falhou em ${f.step}: ${f.error}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[list-continuo-escalation-queue] ${String(error)}`);
    process.exitCode = 1;
  }
}
