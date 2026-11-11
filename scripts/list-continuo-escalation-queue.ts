#!/usr/bin/env npx tsx
/**
 * Fila do briefing com as escaladas do contínuo (#12684) + prazo de validade
 * da escalada (#12765). Falha é explícita, nunca uma fila vazia.
 *
 * Cada PR com `continuo-escalado` há mais de 24h entra em `queue`. Passadas
 * 48h, a escalada deixa de ser "pendência do editor" sem prazo e recebe um
 * DESTINO determinístico (`escalationDestination`):
 *
 *   - `fechar-redundante`   — tudo que a PR muda já está no master (resgate
 *                             órfão cujo conteúdo entrou por outro caminho);
 *   - `fechar-para-issue`   — draft com `bloqueio-execucao`: o bloqueio vive na
 *                             issue, não na lista de PRs; a branch fica;
 *   - `fixer`               — conflito com o master, CI vermelho ou draft
 *                             sem bloqueio (nunca dado por pronto), 1ª vez:
 *                             o coordenador despacha `dev-fixer` (rebase + fix)
 *                             e marca `continuo-ci-fix-tentado`;
 *   - `fechar-reabrir-issue`— conflito/CI vermelho depois da tentativa do
 *                             fixer: fecha a PR e devolve a issue para a fila;
 *   - `briefing`            — o resto (diff grande, caminho sensível, sem
 *                             veredito): decisão de merge do editor.
 *
 * `--apply` executa os três destinos `fechar-*` (fechar PR é reversível:
 * `gh pr reopen`; a branch nunca é apagada). `fixer` e `briefing` precisam de
 * agente/editor e ficam com o coordenador do overnight/develop.
 *
 * Uso: npx tsx scripts/list-continuo-escalation-queue.ts [--apply]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { isMainModule } from "./lib/cli-args.ts";

const ESCALATION_LABEL = "continuo-escalado";
const HOUR_MS = 60 * 60 * 1000;
export const ESCALATION_QUEUE_AFTER_MS = 24 * HOUR_MS;
export const ESCALATION_EXPIRY_MS = 48 * HOUR_MS;

type LabelEvent = { event: string; label?: { name: string }; created_at: string };

/** Pure: desde quando a escalada corrente está aberta (último `labeled` sem `unlabeled` depois). */
export function escalationSince(events: LabelEvent[]): string | null {
  let since: string | null = null;
  for (const event of events) {
    if (event.label?.name !== ESCALATION_LABEL) continue;
    if (event.event === "labeled") since = event.created_at;
    if (event.event === "unlabeled") since = null;
  }
  return since;
}

export function overdueEscalation(events: LabelEvent[], now: number): string | null {
  const since = escalationSince(events);
  return since && now - Date.parse(since) > ESCALATION_QUEUE_AFTER_MS ? since : null;
}

/**
 * Lê todas as páginas de um endpoint de lista do GitHub sem `--slurp` (#12765):
 * o `gh` do servidor 300 é 2.46, e `--slurp` só existe a partir do 2.48 — a
 * fila quebrava inteira ali. Para quando uma página vem com menos que
 * `perPage` itens. Teto de páginas para nunca entrar em laço.
 */
export function fetchAllPages<T>(fetchPage: (page: number, perPage: number) => T[], perPage = 100, maxPages = 50): T[] {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = fetchPage(page, perPage);
    if (!Array.isArray(items)) throw new Error(`página ${page} não é array`);
    all.push(...items);
    if (items.length < perPage) return all;
  }
  throw new Error(`mais de ${maxPages} páginas — leitura truncada`);
}

export type EscalationDestination =
  | "briefing"
  | "fixer"
  | "fechar-redundante"
  | "fechar-para-issue"
  | "fechar-reabrir-issue";

export interface DestinationInput {
  ageMs: number;
  isDraft: boolean;
  labels: string[];
  mergeStateStatus?: string | null;
  gateReason?: string | null;
  /** `true` = todo arquivo que a PR muda já está igual no master. */
  redundant: boolean;
}

/** Pure: destino da escalada. Antes de 48h é sempre `briefing` (comportamento do #12684). */
export function escalationDestination(input: DestinationInput): EscalationDestination {
  if (input.ageMs <= ESCALATION_EXPIRY_MS) return "briefing";
  if (input.redundant) return "fechar-redundante";
  if (input.isDraft && input.labels.includes("bloqueio-execucao")) return "fechar-para-issue";
  const conflict = input.mergeStateStatus === "DIRTY";
  const ciRed = /^CI: fail/i.test(input.gateReason ?? "");
  // Draft sem bloqueio parado 48h = o autor nunca o deu por pronto (tipicamente
  // `draft-ci-vermelho` do overnight). Mesmo caminho do conflito/CI vermelho.
  if (conflict || ciRed || input.isDraft) {
    return input.labels.includes("continuo-ci-fix-tentado") ? "fechar-reabrir-issue" : "fixer";
  }
  return "briefing";
}

/** Pure: issue de origem da PR — branch `fix-N`, depois `Closes #N` no corpo, depois `(#N)` no título. */
export function originIssue(pr: { headRefName: string; title: string; body?: string | null }): number | null {
  // Resgate de órfão (#7130) não tem issue de origem própria: o `(#7130)` do
  // título é a issue genérica do mecanismo, e comentar lá seria ruído.
  if (pr.headRefName.startsWith("continuo/rescue-")) return null;
  const branch = /(?:^|\/)fix-(\d+)(?:-|$)/.exec(pr.headRefName);
  if (branch) return Number(branch[1]);
  const closes = /\b(?:closes|fixes|resolves)\s+#(\d+)/i.exec(pr.body ?? "");
  if (closes) return Number(closes[1]);
  const title = /\(#(\d+)\)/.exec(pr.title);
  return title ? Number(title[1]) : null;
}

/** Pure: texto do comentário de fechamento. */
export function closingComment(dest: EscalationDestination, pr: { headRefName: string }, since: string, issue: number | null): string {
  const why: Record<string, string> = {
    "fechar-redundante": "todo arquivo que esta PR altera já está igual no master — nada a mergear",
    "fechar-para-issue": "é draft com `bloqueio-execucao`: o bloqueio fica registrado na issue, não na lista de PRs",
    "fechar-reabrir-issue": "seguiu com conflito ou CI vermelho depois da tentativa do fixer (`continuo-ci-fix-tentado`)",
  };
  return [
    `Fechada pelo prazo de escalada do contínuo (#12765): escalada desde ${since}, mais de 48h sem destino.`,
    "",
    `Motivo: ${why[dest] ?? dest}.`,
    `A branch \`${pr.headRefName}\` foi preservada; \`gh pr reopen\` desfaz.`,
    issue ? `Issue de origem: #${issue}.` : "",
  ].filter(Boolean).join("\n");
}

function gh(args: string[]): unknown {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: 60_000 }));
}

function ghRun(args: string[]): void {
  execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
}

/** I/O: todo arquivo que a PR muda está igual no master? Erro de git → `false` (nunca fecha por dúvida). */
function isRedundant(headRefName: string): boolean {
  try {
    const ref = `refs/remotes/origin/${headRefName}`;
    execFileSync("git", ["fetch", "-q", "origin", "+refs/heads/master:refs/remotes/origin/master", `+refs/heads/${headRefName}:${ref}`], { timeout: 120_000, stdio: "ignore" });
    const files = execFileSync("git", ["diff", "--name-only", `origin/master...${ref}`], { encoding: "utf8" })
      .split("\n").filter(Boolean);
    if (files.length === 0) return true;
    const same = spawnSync("git", ["diff", "--quiet", "origin/master", ref, "--", ...files]);
    return same.status === 0;
  } catch {
    return false;
  }
}

interface OpenEscalatedPr {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  isDraft: boolean;
  mergeStateStatus: string;
  labels: { name: string }[];
}

if (isMainModule(import.meta.url)) {
  const apply = process.argv.includes("--apply");
  try {
    const prs = gh([
      "pr", "list", "--state", "open", "--label", ESCALATION_LABEL, "--limit", "1000",
      "--json", "number,url,title,body,headRefName,isDraft,mergeStateStatus,labels",
    ]) as OpenEscalatedPr[];
    // Do not silently truncate a large queue.
    if (prs.length >= 1000) throw new Error("fila atingiu limite de paginação");
    const now = Date.now();
    const queue = [];
    const applied = [];
    for (const pr of prs) {
      const events = fetchAllPages((page, perPage) =>
        gh(["api", `repos/{owner}/{repo}/issues/${pr.number}/events?per_page=${perPage}&page=${page}`]) as LabelEvent[],
      );
      const since = overdueEscalation(events, now);
      if (!since) continue;
      const gate = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-continuo-merge-gate.ts", "--pr", String(pr.number)], { encoding: "utf8", timeout: 180_000 });
      if (gate.error || ![0, 1, 2].includes(gate.status ?? -1)) throw new Error(`gate #${pr.number} falhou: ${gate.stderr}`);
      const result = JSON.parse(gate.stdout);
      const labels = pr.labels.map((l) => l.name);
      const ageMs = now - Date.parse(since);
      const destination = escalationDestination({
        ageMs,
        isDraft: pr.isDraft,
        labels,
        mergeStateStatus: pr.mergeStateStatus,
        gateReason: result.reason,
        redundant: ageMs > ESCALATION_EXPIRY_MS && isRedundant(pr.headRefName),
      });
      const issue = originIssue(pr);
      queue.push({
        number: pr.number, url: pr.url, since, owner: "editor", queue: "briefing overnight/develop",
        action: result.action, reason: result.reason, expired: ageMs > ESCALATION_EXPIRY_MS, destination, issue,
      });
      if (!apply || !destination.startsWith("fechar-")) continue;
      ghRun(["pr", "close", String(pr.number), "--comment", closingComment(destination, pr, since, issue)]);
      if (destination === "fechar-reabrir-issue" && issue) {
        const state = (gh(["issue", "view", String(issue), "--json", "state"]) as { state: string }).state;
        if (state === "CLOSED") ghRun(["issue", "reopen", String(issue)]);
        ghRun(["issue", "comment", String(issue), "--body",
          `PR #${pr.number} fechada pelo prazo de escalada (#12765) com conflito/CI vermelho após o fixer. Branch preservada: \`${pr.headRefName}\`. A issue volta para a fila.`]);
      }
      if (destination === "fechar-para-issue" && issue) {
        ghRun(["issue", "comment", String(issue), "--body",
          `PR #${pr.number} (draft com \`bloqueio-execucao\`) fechada pelo prazo de escalada (#12765). O trabalho segue na branch \`${pr.headRefName}\`; o bloqueio continua nesta issue.`]);
      }
      applied.push({ number: pr.number, destination, issue });
    }
    console.log(JSON.stringify(apply ? { queue, applied } : { queue }));
  } catch (error) {
    console.error(`[list-continuo-escalation-queue] ${String(error)}`);
    process.exitCode = 1;
  }
}
