#!/usr/bin/env npx tsx
/**
 * check-state-changed-pending.ts (#5476, convergência fundida em #5706)
 *
 * CLI para o gate de "re-triagem pendente" — ver `scripts/lib/state-changed-tracker.ts`
 * para a lógica pura/documentação completa do mecanismo. Este arquivo é só o
 * ponto de entrada de linha de comando, seguindo o mesmo padrão de
 * `scripts/check-overnight-token-instrumentation.ts`.
 *
 * Desde #5706, o modo padrão (checar) também roda a **re-varredura de
 * convergência** da Fase 1 passo 6 (`gh issue list --state open` completo,
 * comparado contra `goal.target_set`/`goal.tiers`/`issues[]` do plano) — um
 * ÚNICO gate cobrindo tanto pendências explícitas quanto issue nova nunca
 * triangulada, em vez de duas checagens de nome parecido e escopo diferente
 * (era a causa raiz do #5706: o coordenador rodou só a pendência explícita,
 * viu "ok" e leu isso como se cobrisse a convergência também). `gh`
 * indisponível/offline não trava a sessão — vira warning em stderr e o
 * comando degrada pro comportamento antigo (só pendência explícita), no
 * espírito fail-soft do #738; `--skip-convergence` faz o mesmo
 * proativamente.
 *
 * Uso:
 *   # checar (modo padrão): sai 1 se houver pendência OU issue nova não-triangulada
 *   npx tsx scripts/check-state-changed-pending.ts --plan data/overnight/260817/plan.json
 *
 *   # Desde #10407 o mesmo fetch também re-classifica (`classifyExecTrack`)
 *   # as entradas de `issues[]` marcadas "não trabalhada por esta sessão"
 *   # (`deixado-para-o-300`; e `claimed-por-outra-sessao` em plano develop) —
 *   # track que virou develop/bloqueada desde a gravação → exit 1.
 *   # #11301 item 2: também acusa bloqueio-externo inicial cujo track atual
 *   # deixou de ser bloqueada, antes de reaplicar decisão obsoleta.
 *   # `--kind develop|overnight|continuo` sobrepõe a inferência pelo path.
 *
 *   # #10618 (fatia 3): plano com issue de outro repo (`"vjpixel/diaria-design#21"`)
 *   # também varre os repos dela (`gh issue list -R owner/repo`), só os da
 *   # allowlist `platform.config.json → issue_repos`. Issue nova do outro repo
 *   # sai como `owner/repo#N`; falha do `gh` num repo extra é aviso (aquele
 *   # repo NÃO avaliado), igual ao fail-soft do default. Plano só-studio não
 *   # faz chamada extra nenhuma.
 *
 *   # pular a re-varredura de convergência (gh indisponível/offline)
 *   npx tsx scripts/check-state-changed-pending.ts --plan {path} --skip-convergence
 *
 *   # registrar pendência (ex: acabou de aplicar uma label de classificação
 *   # ou remover uma claim de session-registry durante a rodada)
 *   npx tsx scripts/check-state-changed-pending.ts --add-pending 5480 --plan data/overnight/260817/plan.json
 *
 *   # resolver pendência (depois de reavaliar dispatch pra essa issue)
 *   npx tsx scripts/check-state-changed-pending.ts --remove-pending 5480 --plan data/overnight/260817/plan.json
 *
 * @see scripts/lib/state-changed-tracker.ts
 * @see scripts/check-overnight-token-instrumentation.ts (padrão de estilo)
 * @see scripts/check-decision-label-drift.ts (padrão de fetch de `gh issue list` fail-soft, reusado aqui)
 * @see .claude/skills/diaria-overnight/SKILL.md
 * @see .claude/skills/diaria-develop/SKILL.md
 * @see .claude/skills/diaria-continuo/SKILL.md
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  addPendingToPlan,
  checkStateChangedPending,
  checkConvergenceScan,
  findMissingForeignConvergenceKeys,
  findRetrackedUnworkedForeignIssues,
  findRetrackedUnworkedIssues,
  convergenceReposOfPlan,
  recordConvergenceScan,
  type ConvergenceScanIssue,
  type PlanWithGoal,
  type RetrackedUnworkedIssue,
  removePendingFromPlan,
  addForeignPendingToPlan,
  removeForeignPendingFromPlan,
} from "./lib/state-changed-tracker.ts";
import { formatIssueRef, ISSUE_REPOS_CONFIG_ROOT, legacyIssueNumber, loadIssueRepos, parseIssueRef } from "./lib/issue-repos.ts";
import type { IssueKey } from "./lib/issue-key.ts";

/** #10407 — `claimed-por-outra-sessao` só conta na re-classificação numa
 * sessão develop (overnight/continuo não pegam develop/bloqueada, seria
 * ruído). `--kind` explícito vence; sem ele, infere pelo segmento `develop`
 * do path (`data/develop/{AAMMDD}/plan.json`, convenção dos 3 SKILL.md).
 * Exportado para teste. */
export function isDevelopPlan(planPath: string, kind?: string): boolean {
  if (kind !== undefined) return kind === "develop";
  return planPath.split(/[\\/]/).includes("develop");
}

interface GhIssueListItem {
  number: number;
  labels?: Array<{ name?: string } | string>;
  body?: string | null;
}

/** Exportado (#6435) — `scripts/check-overnight-fila-convergence-gate.ts`
 * reusa exatamente este shape em vez de redeclarar. */
export interface FetchOpenIssuesResult {
  issues: ConvergenceScanIssue[];
  error?: string;
}

// Folga generosa sobre o backlog aberto real (34 issues na medição de
// 260819) — não um teto pensado pra nunca estourar.
// `fetchOpenIssuesForConvergence` compara `issues.length` contra este valor
// e trata bater exatamente como fetch INCOMPLETO (sinal de truncamento
// silencioso do `gh issue list --limit`) em vez de assumir cobertura
// completa sem checar — ver o comentário dentro dessa função.
const CONVERGENCE_ISSUE_LIMIT = 200;

/** Busca as issues abertas (até `CONVERGENCE_ISSUE_LIMIT`, número + labels +
 * body) via `gh issue list` — mesmo padrão fail-soft de
 * `scripts/check-decision-label-drift.ts` (`fetchOpenIssues`): nunca lança,
 * qualquer falha (CLI ausente, sem auth, rate limit, JSON malformado) volta
 * como `{ issues: [], error }` pra `main()` decidir degradar em vez de
 * travar. */
/** Exportado (#6435) — mesma fonte única que `scripts/check-overnight-fila-convergence-gate.ts`
 * (gate mecânico da Fase 1 passo 1) usa, em vez de duplicar o fetch fail-soft
 * + a detecção de truncamento por `--limit`. */
export function fetchOpenIssuesForConvergence(cwd: string, repo?: string): FetchOpenIssuesResult {
  // #10618 (fatia 3): `repo` = outro repo da allowlist → `-R owner/repo`. Sem
  // `repo`, a chamada de sempre (o diaria-studio, pelo cwd).
  const result = spawnSync(
    "gh",
    [
      "issue",
      "list",
      ...(repo ? ["-R", repo] : []),
      "--state",
      "open",
      "--limit",
      String(CONVERGENCE_ISSUE_LIMIT),
      "--json",
      "number,labels,body",
    ],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) {
    return { issues: [], error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return {
      issues: [],
      error: `gh issue list saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  if (!result.stdout) {
    return { issues: [], error: "gh issue list retornou stdout vazio" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return { issues: [], error: `JSON malformado de gh issue list: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { issues: [], error: "gh issue list retornou payload que não é um array" };
  }
  const issues = (parsed as GhIssueListItem[]).map((raw) => ({
    number: raw.number,
    labels: (raw.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l?.name))
      .filter((n): n is string => typeof n === "string" && n.length > 0),
    body: raw.body ?? null,
  }));
  // Achado do fleet review (#5713): `--limit N` bate exatamente em N sem
  // sinalizar truncamento — se o backlog aberto real passar do limite, as
  // excedentes ficam invisíveis e o gate reportaria "ok" com issue nova de
  // verdade fora da varredura. Tratado como o MESMO caminho "não avaliado"
  // de qualquer outra falha de fetch (nunca como sucesso parcial) — o
  // chamador cai no fail-soft de `gh` indisponível, que já é honesto sobre
  // não ter rodado (Achado 1 do mesmo review).
  if (issues.length === CONVERGENCE_ISSUE_LIMIT) {
    return {
      issues: [],
      error: `gh issue list retornou exatamente ${CONVERGENCE_ISSUE_LIMIT} issues (o limite) — resultado pode estar truncado, backlog aberto pode ser maior; tratando como fetch incompleto`,
    };
  }
  return { issues };
}

export interface ForeignConvergenceScan {
  /** Issue nova (fora do plano) de outro repo, `owner/repo#N`. */
  missing: IssueKey[];
  /** `"owner/repo (motivo)"` — repo que NÃO foi varrido (fora da allowlist ou `gh` falhou). */
  notScanned: string[];
  /** #10407 aplicado aos repos extras. */
  retracked: RetrackedUnworkedIssue[];
}

/**
 * I/O (#10618, fatias 3-4): re-varredura de convergência dos repos que não
 * são o diaria-studio. Varre `convergenceReposOfPlan` — os repos que o plano
 * cita e, desde a fatia 4, todo repo da allowlist `issue_repos` (o design
 * entra por padrão na fila das rodadas). Repo citado no plano mas fora da
 * allowlist nunca é consultado (typo/fork) e volta em `notScanned`.
 * Fonte única para `check-state-changed-pending.ts` (Fase 2) e
 * `check-overnight-fila-convergence-gate.ts` (Fase 1 passo 1).
 */
export function scanForeignConvergence(
  plan: PlanWithGoal,
  cwd: string,
  opts: { includeClaimed?: boolean } = {},
  fetcher: (cwd: string, repo: string) => FetchOpenIssuesResult = fetchOpenIssuesForConvergence,
): ForeignConvergenceScan {
  const allowlist = loadIssueRepos(ISSUE_REPOS_CONFIG_ROOT);
  const allowed = new Set(allowlist);
  const out: ForeignConvergenceScan = { missing: [], notScanned: [], retracked: [] };
  for (const repo of convergenceReposOfPlan(plan, allowlist)) {
    if (!allowed.has(repo)) {
      out.notScanned.push(`${repo} (fora de issue_repos)`);
      continue;
    }
    const extra = fetcher(cwd, repo);
    if (extra.error) {
      out.notScanned.push(`${repo} (${extra.error.split("\n")[0]})`);
      continue;
    }
    out.missing.push(...findMissingForeignConvergenceKeys(plan, repo, extra.issues));
    out.retracked.push(
      ...findRetrackedUnworkedForeignIssues(plan, repo, extra.issues, { includeClaimed: opts.includeClaimed }),
    );
  }
  return out;
}

/** #10618 (fatia 2): aceita `N` (legado = diaria-studio) e `owner/repo#N`.
 * Devolve o número legado quando é do repo default; a ref canônica quando é
 * de outro repo. */
function parseIssueArg(raw: string, flag: string): { legacy: number } | { foreign: string } {
  const ref = parseIssueRef(raw);
  if (!ref) {
    console.error(`[check-state-changed-pending] --${flag} inválido: ${raw} (esperado N ou owner/repo#N)`);
    process.exit(2);
  }
  const legacy = legacyIssueNumber(ref);
  return legacy !== null ? { legacy } : { foreign: formatIssueRef(ref) };
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error(
      "[check-state-changed-pending] uso: --plan {path} [--add-pending N | --remove-pending N]",
    );
    process.exit(2);
  }

  if (!existsSync(planPath)) {
    console.error(`[check-state-changed-pending] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  if (values["add-pending"] !== undefined) {
    const arg = parseIssueArg(values["add-pending"], "add-pending");
    if ("legacy" in arg) addPendingToPlan(planPath, arg.legacy);
    else addForeignPendingToPlan(planPath, arg.foreign);
    const label = "legacy" in arg ? `#${arg.legacy}` : arg.foreign;
    console.log(`[check-state-changed-pending] ${label} adicionada a state_changed_issues (${planPath}).`);
    process.exit(0);
  }

  if (values["remove-pending"] !== undefined) {
    const arg = parseIssueArg(values["remove-pending"], "remove-pending");
    if ("legacy" in arg) removePendingFromPlan(planPath, arg.legacy);
    else removeForeignPendingFromPlan(planPath, arg.foreign);
    const label = "legacy" in arg ? `#${arg.legacy}` : arg.foreign;
    console.log(`[check-state-changed-pending] ${label} removida de state_changed_issues (${planPath}).`);
    process.exit(0);
  }

  // Modo padrão: checar pendência explícita + (#5706) re-varredura de
  // convergência. Ambas rodam sempre que possível — `exit 1` se qualquer
  // uma achar algo, listando as duas categorias separadamente.
  const pendingResult = checkStateChangedPending(planPath);

  let convergenceMissing: number[] = [];
  // `convergenceRan` distingue "rodou e achou zero" de "não rodou" — achado
  // no self-review (#5706): sem essa distinção, a mensagem de sucesso final
  // reafirmava "nenhuma issue nova fora da varredura" mesmo quando a
  // varredura tinha sido pulada (`--skip-convergence` ou `gh` indisponível),
  // reintroduzindo exatamente a classe de falso-"ok" que este gate existe
  // pra fechar.
  let convergenceRan = false;
  let retracked: RetrackedUnworkedIssue[] = [];
  // #10618 (fatia 3): issue nova de outro repo citado no plano.
  let foreignMissing: IssueKey[] = [];
  const foreignNotScanned: string[] = [];
  const foreignRetracked: RetrackedUnworkedIssue[] = [];
  if (flags.has("skip-convergence")) {
    console.error(
      "[check-state-changed-pending] --skip-convergence: pulando re-varredura de convergência (não avaliada nesta invocação).",
    );
  } else {
    const fetched = fetchOpenIssuesForConvergence(process.cwd());
    if (fetched.error) {
      console.error(
        `[check-state-changed-pending] gh indisponível — pulando re-varredura de convergência (fail-soft, #738): ${fetched.error}`,
      );
    } else {
      let planRaw: unknown;
      try {
        planRaw = JSON.parse(readFileSync(planPath, "utf8"));
      } catch (e) {
        console.error(
          `[check-state-changed-pending] plan.json malformado — pulando re-varredura de convergência (fail-soft, #738): ${(e as Error).message}`,
        );
        planRaw = undefined;
      }
      if (planRaw !== undefined) {
        const convergence = checkConvergenceScan(planRaw as PlanWithGoal, fetched.issues);
        convergenceMissing = convergence.status === "missing" ? convergence.issues : [];
        const includeClaimed = isDevelopPlan(planPath, values.kind);
        const foreign = scanForeignConvergence(planRaw as PlanWithGoal, process.cwd(), { includeClaimed });
        foreignMissing = foreign.missing;
        foreignNotScanned.push(...foreign.notScanned);
        foreignRetracked.push(...foreign.retracked);
        recordConvergenceScan(
          planPath,
          convergence.novas_encontradas + foreignMissing.length,
          undefined,
          foreignNotScanned,
        );
        convergenceRan = true;
        // #10407 — issue JÁ no plano como "não trabalhada por esta sessão"
        // que outra sessão re-roteou pra develop/bloqueada no meio da rodada.
        retracked = [
          ...findRetrackedUnworkedIssues(planRaw as PlanWithGoal, fetched.issues, { includeClaimed }),
          ...foreignRetracked,
        ];
      }
    }
  }

  if (foreignNotScanned.length > 0) {
    console.error(
      `[check-state-changed-pending] re-varredura de convergência NÃO executada para: ${foreignNotScanned.join("; ")} (#10618 — issue nova e re-roteamento (#10407) desses repos não foram checados)`,
    );
  }

  if (
    pendingResult.status === "ok" &&
    convergenceMissing.length === 0 &&
    foreignMissing.length === 0 &&
    retracked.length === 0
  ) {
    const convergenceNote = convergenceRan
      ? `nenhuma issue nova fora da varredura, nenhuma divergência de track nas issues não trabalhadas do plano${foreignNotScanned.length > 0 ? " (exceto nos repos NÃO varridos acima)" : ""}`
      : "re-varredura de convergência NÃO executada (--skip-convergence ou gh indisponível) — só pendência explícita foi checada";
    console.log(`ok — nenhuma pendência de re-triagem, ${convergenceNote}`);
    process.exit(0);
  }

  if (pendingResult.status !== "ok") {
    const list = [
      ...pendingResult.issues.map((n) => `#${n}`),
      ...(pendingResult.foreign ?? []),
      // #10618: entrada ilegível bloqueia (nunca some) — exibida crua.
      ...(pendingResult.unreadable ?? []).map((v) => `ilegível ${v}`),
    ].join(", ");
    console.error(
      `pendências de re-triagem: ${list} — reavalie dispatch antes de fechar a rodada`,
    );
  }
  if (convergenceMissing.length > 0 || foreignMissing.length > 0) {
    const list = [...convergenceMissing.map((n) => `#${n}`), ...foreignMissing].join(", ");
    console.error(
      `re-varredura de convergência: issue(s) nova(s) fora de target_set/tiers/issues e não-triangulada(s) (agendada/bloqueada/fora-de-rodada): ${list} — classifique e reavalie dispatch antes de fechar a rodada`,
    );
  }
  if (retracked.length > 0) {
    const list = retracked
      .map((r) => `${r.key ?? `#${r.number}`} (${r.motivo}, ${r.track_gravado ?? "sem exec_track_painel"} → ${r.track_atual})`)
      .join(", ");
    console.error(
      `re-classificação (#10407) / bloqueio obsoleto (#11301): issue(s) não trabalhada(s) com track divergente ou bloqueio inicial obsoleto: ${list} — releia o roteamento atual antes de re-rotear; atualize exec_track_painel e reavalie dispatch antes de fechar a rodada`,
    );
  }
  process.exit(1);
}
