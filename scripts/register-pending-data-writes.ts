#!/usr/bin/env npx tsx
/**
 * register-pending-data-writes.ts (#12034)
 *
 * Depois de um merge do contínuo, registra a escrita pendente em `data/` que
 * a PR declarou no corpo (seção `## Escrita pendente em \`data/\` (#11780)`,
 * item 35 de `context/overnight-dispatch-rules.md`).
 *
 * No contínuo de produção quem mergeia é `hermes/scripts/continuo-pr-review.sh`
 * (#7702), não uma sessão que leia o `SKILL.md`, então o lembrete do #11835
 * ("aplicar a seção depois do merge") não chega lá. Este CLI fecha o caminho:
 * o script bash o chama depois de um merge confirmado.
 *
 * **Registra, não aplica.** A issue admitia as duas saídas (aplicar quando o
 * formato for determinístico, ou abrir issue/alarme). O formato do item 35 é
 * prosa ("`chave` de `X` para `Y`", ou o conteúdo inteiro de um arquivo novo),
 * sem gramática que permita gravar sem julgamento — e gravar num `data/`
 * compartilhado por OneDrive a partir de um cron, sem review, é justo o que o
 * item 35 evita. Por isso: abre (ou reusa) uma issue de alarme com as linhas,
 * via `ensureAlarmIssue` (`scripts/lib/alarm-issues.ts`, família `evento`,
 * marcador por PR — uma issue por PR, nunca duplicada entre ticks). A issue
 * cai no track overnight (`alarm-evento`), onde o coordenador aplica.
 *
 * Uso:
 *   npx tsx scripts/register-pending-data-writes.ts --pr 123
 *   npx tsx scripts/register-pending-data-writes.ts --pr 123 --dry-run
 *
 * Saída: 1 linha JSON no stdout (`outcome`: `none` | `not-merged` |
 * `registered` | `dry-run` | `failed`).
 * Exit codes:
 *   0 = nada a registrar, ou registrado (issue criada/reusada/reaberta)
 *   1 = havia escrita pendente e a issue NÃO foi registrada (`failed`)
 *   2 = uso inválido
 *   3 = PR ilegível (`gh pr view` falhou ou JSON inesperado)
 * Quem chama (o `continuo-pr-review.sh`) trata 1 e 3 como erro de infra do
 * tick, fail-soft: nunca desfaz nem bloqueia o merge, que já aconteceu.
 */

import { isMainModule, getIntArg } from "./lib/cli-args.ts";
import { extractPendingDataWrites, type PendingDataWrite } from "./lib/pending-data-writes.ts";
import { defaultAlarmGhRun, ensureAlarmIssue, type AlarmFinding, type GhRunFn } from "./lib/alarm-issues.ts";

export const PENDING_DATA_WRITES_CHECK = "escrita-pendente-data";

export type RegisterOutcome =
  | { outcome: "none"; pr: number }
  | { outcome: "not-merged"; pr: number; state: string }
  | { outcome: "dry-run"; pr: number; writes: PendingDataWrite[]; title: string }
  | {
      outcome: "registered";
      pr: number;
      writes: PendingDataWrite[];
      issue: number;
      url: string;
      action: "created" | "reused" | "reopened" | "updated";
    }
  | { outcome: "failed"; pr: number; writes: PendingDataWrite[]; error: string }
  | { outcome: "unreadable"; pr: number; error: string };

export function exitCodeFor(r: RegisterOutcome): number {
  if (r.outcome === "failed") return 1;
  if (r.outcome === "unreadable") return 3;
  return 0;
}

/** Pura — o achado de alarme da escrita pendente de uma PR mergeada. */
export function buildPendingDataWritesFinding(
  pr: { number: number; title: string; url: string },
  writes: readonly PendingDataWrite[],
): AlarmFinding {
  const body =
    `A PR #${pr.number} (${pr.title}, ${pr.url}) foi mergeada pelo contínuo ` +
    "(`hermes/scripts/continuo-pr-review.sh`) e declarava escrita pendente em `data/` " +
    "(item 35 de `context/overnight-dispatch-rules.md`, #11780).\n\n" +
    "O script não aplica a escrita sozinho (#12034): o formato da linha é prosa, sem gramática " +
    "que permita gravar no `data/` compartilhado sem julgamento. Aplicar cada linha no checkout " +
    "principal (Edit cirúrgico, #495), registrar e fechar esta issue.\n\n" +
    "## Escrita pendente\n\n" +
    writes.map((w) => `- ${w.line}`).join("\n") +
    "\n\nPrioridade P2: a escrita faz parte do estado pós-merge e, sem esta issue, ficaria sem registro nenhum.";
  return {
    check: PENDING_DATA_WRITES_CHECK,
    fingerprint: `pr-${pr.number}`,
    title: `Escrita pendente em data/ da PR #${pr.number} (#12034)`,
    body,
    family: "evento",
    labels: ["enhancement"],
    priority: "P2",
  };
}

/**
 * Lê o corpo da PR e registra a escrita pendente. `run` injetável (teste usa
 * um fake; o default é o `gh` real, que recusa rodar sob `node --test`).
 */
export function registerPendingDataWrites(opts: {
  pr: number;
  cwd: string;
  dryRun?: boolean;
  run?: GhRunFn;
}): RegisterOutcome {
  const run = opts.run ?? defaultAlarmGhRun;
  const view = run(["pr", "view", String(opts.pr), "--json", "number,title,url,state,body"], opts.cwd);
  if (view.status !== 0) {
    return { outcome: "unreadable", pr: opts.pr, error: `gh pr view falhou: ${view.stderr.trim() || `status ${view.status}`}` };
  }
  let data: { number?: unknown; title?: unknown; url?: unknown; state?: unknown; body?: unknown };
  try {
    data = JSON.parse(view.stdout) as typeof data;
  } catch (err) {
    return { outcome: "unreadable", pr: opts.pr, error: `JSON malformado de gh pr view: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!data || typeof data !== "object" || typeof data.body !== "string") {
    return { outcome: "unreadable", pr: opts.pr, error: "gh pr view sem campo body" };
  }

  const writes = [...extractPendingDataWrites(data.body).writes];
  if (writes.length === 0) return { outcome: "none", pr: opts.pr };
  // A escrita pertence ao estado pós-merge (item 35): PR não mergeada não
  // tem nada a aplicar ainda, e registrar agora geraria issue prematura.
  if (data.state !== "MERGED") return { outcome: "not-merged", pr: opts.pr, state: String(data.state) };

  const finding = buildPendingDataWritesFinding(
    {
      number: opts.pr,
      title: typeof data.title === "string" ? data.title : "(título ilegível)",
      url: typeof data.url === "string" ? data.url : `#${opts.pr}`,
    },
    writes,
  );
  if (opts.dryRun) return { outcome: "dry-run", pr: opts.pr, writes, title: finding.title };

  const res = ensureAlarmIssue(finding, undefined, opts.cwd, run);
  if (res.action === "failed" || res.issueNumber === null || res.url === null) {
    return { outcome: "failed", pr: opts.pr, writes, error: res.error ?? "ensureAlarmIssue falhou sem motivo" };
  }
  return { outcome: "registered", pr: opts.pr, writes, issue: res.issueNumber, url: res.url, action: res.action };
}

function main(): void {
  const argv = process.argv.slice(2);
  let pr: number | undefined;
  try {
    pr = getIntArg(argv, "pr", { min: 1 });
  } catch (err) {
    console.error(`register-pending-data-writes: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }
  if (pr === undefined) {
    console.error("register-pending-data-writes: --pr N é obrigatório");
    process.exit(2);
    return;
  }
  const result = registerPendingDataWrites({ pr, cwd: process.cwd(), dryRun: argv.includes("--dry-run") });
  console.log(JSON.stringify(result));
  process.exit(exitCodeFor(result));
}

if (isMainModule(import.meta.url)) {
  main();
}
