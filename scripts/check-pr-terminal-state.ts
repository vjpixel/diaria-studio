#!/usr/bin/env npx tsx
/**
 * check-pr-terminal-state.ts (#5831)
 *
 * CLI para o gate de "todo PR aberto por esta sessão chegou a um estado
 * terminal antes do relatório final" — ver `scripts/lib/pr-terminal-state.ts`
 * para a lógica pura/documentação completa do mecanismo. Este arquivo é só
 * o ponto de entrada de linha de comando, mesmo padrão de
 * `scripts/check-overnight-comment-coverage.ts`/`scripts/check-state-changed-pending.ts`.
 *
 * Roda na Fase 2 (relatório final) de `/diaria-develop` e `/diaria-overnight`,
 * junto dos gates irmãos (`check-state-changed-pending.ts`,
 * `check-overnight-comment-coverage.ts`). `exit 1` = há PR aberto no GitHub
 * que esta sessão deveria ter fechado (mergeado ou fechado sem merge) e não
 * fechou — voltar, checar o PR (`gh pr view N`), mergear/fechar/atualizar o
 * `plan.json` com o status correto antes de escrever o relatório. PR retida
 * para o editor (label/marcador `retido-para-editor`, #10278, ou status
 * `retida-para-editor` no plano) é terminal; PR `overnight/`/`develop/`/`fix/`
 * sem registro no plano é só AVISO (candidata, `exit 0`) — #10430.
 *
 * PR de OUTRA rodada viva (#10439) — issue do branch `fix-{N}` reivindicada
 * por outra sessão do `session-registry`, ou número em `plan.json.alien_prs_confirmed`
 * — sai da lista de candidatos e é listada como "alheia confirmada".
 *
 * **#10618 (fatia 3) — multi-repo.** O PR de uma issue mora no repo dela:
 * entrada `"vjpixel/diaria-design#21"` com `pr: 23` é cruzada com os PRs
 * abertos do diaria-design (`gh pr list -R vjpixel/diaria-design`), nunca com
 * o PR #23 do studio. Os repos extras consultados são os de TODA entrada do
 * `plan.json` de outro repo (`issueKeyOfPlanEntry`, com ou sem `pr` — um PR
 * `develop/fix-N-*` esquecido no diaria-design, sem registro no plano, só
 * aparece como candidato se o repo dele for consultado) que estão na
 * allowlist `platform.config.json → issue_repos`. Repo fora dela, entrada de
 * identidade desconhecida e falha do `gh` num repo extra viram aviso em
 * stderr E ressalva na linha de veredito ("ok PARCIAL — NÃO avaliados: …"),
 * nunca "ok" sem ressalva. PR registrado num repo não consultado é listado
 * como NÃO avaliado — nunca lido como "fechado" por não estar na lista.
 *
 * Uso:
 *   npx tsx scripts/check-pr-terminal-state.ts --plan data/overnight/260820/plan.json
 *   npx tsx scripts/check-pr-terminal-state.ts --plan {path} --skip-gh-checks
 *   npx tsx scripts/check-pr-terminal-state.ts --plan {path} --root {repoRoot}  # data/sessions/ (default: cwd)
 *
 * @see scripts/lib/pr-terminal-state.ts
 * @see scripts/check-overnight-comment-coverage.ts (padrão de estilo/gate irmão)
 * @see .claude/skills/diaria-overnight/SKILL.md (Fase 2)
 * @see .claude/skills/diaria-develop/SKILL.md (Fase 2)
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { normalizeIssues, type IssuesBearing } from "./lib/plan-issues-normalize.ts";
import { listActiveSessions } from "./lib/session-registry.ts";
import { DEFAULT_ISSUE_REPO, loadIssueRepos } from "./lib/issue-repos.ts";
import {
  describeUnknownPlanEntry,
  issueKeyOfPlanEntry,
  planEntryDeclaresIdentity,
  repoOfIssueKey,
} from "./lib/issue-key.ts";
import {
  checkPrTerminalState,
  foreignClaimedIssueKeys,
  foreignClaimedIssues,
  prRepoOfPlanEntry,
  readAlienPrKeysConfirmed,
  readAlienPrsConfirmed,
  verdictExitCode,
  type LiveSessionLike,
  type OpenPrLike,
  type PlanIssueWithPrLike,
} from "./lib/pr-terminal-state.ts";

interface GhFetchResult<T> {
  value: T | null;
  error?: string;
}

/** Fail-soft: nunca lança. `gh` ausente, sem auth, rate-limited, JSON
 * malformado — tudo vira `{ value: null, error }` pro chamador decidir. */
function fetchOpenPrs(cwd: string, repo?: string): GhFetchResult<OpenPrLike[]> {
  // #10618 (fatia 3): `repo` = outro repo da allowlist → `-R` e cada PR sai
  // marcado com `repo`. Sem `repo`: a chamada de sempre (diaria-studio pelo cwd).
  const result = spawnSync(
    "gh",
    [
      "pr",
      "list",
      ...(repo ? ["-R", repo] : []),
      "--state",
      "open",
      "--json",
      "headRefName,number,createdAt,labels,body",
      "--limit",
      "200",
    ],
    // maxBuffer: com `body` no payload (#10430), 200 PRs passam fácil do 1 MiB
    // default do spawnSync — estouro viraria fail-soft e desligaria o gate.
    { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) {
    return { value: null, error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return { value: null, error: `gh pr list saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!result.stdout) return { value: null, error: "gh pr list retornou stdout vazio" };
  try {
    const parsed = JSON.parse(result.stdout) as OpenPrLike[];
    if (!repo) return { value: parsed };
    if (!Array.isArray(parsed)) return { value: null, error: "gh pr list retornou payload que não é um array" };
    return { value: parsed.map((pr) => ({ ...pr, repo })) };
  } catch (e) {
    return { value: null, error: `JSON malformado de gh pr list: ${(e as Error).message}` };
  }
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[check-pr-terminal-state] uso: --plan {path} [--skip-gh-checks]");
    process.exit(2);
  }
  if (!existsSync(planPath)) {
    console.error(`[check-pr-terminal-state] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  if (flags.has("skip-gh-checks")) {
    console.error(
      "[check-pr-terminal-state] --skip-gh-checks: pulando checagem de estado terminal de PR (não avaliada nesta invocação).",
    );
    process.exit(0);
  }

  let planRaw: unknown;
  try {
    planRaw = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (e) {
    console.error(
      `[check-pr-terminal-state] plan.json malformado — pulando checagem (fail-soft, #738): ${(e as Error).message}`,
    );
    process.exit(0);
  }

  const fetched = fetchOpenPrs(process.cwd());
  if (fetched.error) {
    console.error(`[check-pr-terminal-state] gh indisponível — pulando checagem (fail-soft, #738): ${fetched.error}`);
    process.exit(0);
  }

  const openPrs = [...(fetched.value ?? [])];
  const planIssues = normalizeIssues<PlanIssueWithPrLike>(planRaw as IssuesBearing<PlanIssueWithPrLike>);

  // #10618 (fatia 3): PRs abertos dos outros repos citados no plano — TODA
  // entrada de outro repo, com ou sem `pr` (PR não registrado em branch
  // `develop/fix-N-*` do design só vira candidato se o repo for consultado).
  // Só repos da allowlist `issue_repos`. Repo não consultado (fora dela, ou
  // `gh` falhou) e identidade desconhecida entram na ressalva da linha final.
  const allowlist = new Set(loadIssueRepos(process.cwd()));
  const extraRepos = new Set<string>();
  /** repo → motivo de não ter sido consultado. */
  const unevaluated = new Map<string, string>();
  const unknownEntries: string[] = [];
  planIssues.forEach((issue, index) => {
    const key = issueKeyOfPlanEntry(issue);
    const repo = key ? repoOfIssueKey(key) : typeof issue.pr === "number" ? prRepoOfPlanEntry(issue) : null;
    if (repo === null) {
      // Só conta entrada que o gate avaliaria: tem PR registrado ou declara
      // identidade (`ref`/`repo`) ilegível. Entrada sem número nem `ref` é
      // ignorada, como sempre.
      if (typeof issue.pr === "number" || planEntryDeclaresIdentity(issue)) {
        unknownEntries.push(describeUnknownPlanEntry(issue, index));
      }
      return;
    }
    if (repo === DEFAULT_ISSUE_REPO) return;
    if (allowlist.has(repo)) extraRepos.add(repo);
    else unevaluated.set(repo, "fora de issue_repos");
  });
  for (const repo of [...extraRepos].sort()) {
    const extra = fetchOpenPrs(process.cwd(), repo);
    if (extra.error) {
      unevaluated.set(repo, `gh falhou: ${extra.error}`);
      continue;
    }
    openPrs.push(...(extra.value ?? []));
  }
  for (const [repo, motivo] of unevaluated) {
    console.error(`[check-pr-terminal-state] aviso (#10618): PRs de ${repo} NÃO avaliados — ${motivo}`);
  }
  for (const d of unknownEntries) {
    console.error(`[check-pr-terminal-state] aviso (#10618): ${d} com identidade desconhecida (repo/ref ilegível) — NÃO avaliada`);
  }
  /** Ressalva da linha de veredito (vazia = cobertura completa). */
  const ressalvaParts = [...unevaluated].map(([repo, motivo]) => `${repo} (${motivo.split("\n")[0]})`);
  if (unknownEntries.length > 0) ressalvaParts.push(`${unknownEntries.length} entrada(s) de identidade desconhecida`);
  const ressalva = ressalvaParts.length > 0 ? `NÃO avaliados: ${ressalvaParts.join("; ")}` : "";
  // #10439: sessões vivas do registry — fail-soft (registro ilegível = sem
  // evidência alheia, nunca reprova por isso).
  let sessions: LiveSessionLike[] = [];
  try {
    sessions = listActiveSessions(values.root ?? process.cwd());
  } catch (e) {
    console.error(`[check-pr-terminal-state] session-registry ilegível — sem cruzamento alheio: ${(e as Error).message}`);
  }
  const ownSessionId =
    planRaw && typeof planRaw === "object" && typeof (planRaw as Record<string, unknown>).session_id === "string"
      ? ((planRaw as Record<string, unknown>).session_id as string)
      : undefined;
  const verdict = checkPrTerminalState(openPrs, planIssues, undefined, {
    confirmedPrs: readAlienPrsConfirmed(planRaw),
    confirmedPrKeys: readAlienPrKeysConfirmed(planRaw),
    liveForeignClaimedIssues: foreignClaimedIssues(sessions, ownSessionId),
    liveForeignClaimedKeys: foreignClaimedIssueKeys(sessions, ownSessionId),
  }, new Set(unevaluated.keys()));
  /** `PR #N` (studio) ou `owner/repo PR #N`. */
  const prLabel = (d: { pr: number; repo?: string }) => (d.repo ? `${d.repo} PR #${d.pr}` : `PR #${d.pr}`);

  if (verdict.alienConfirmed.length > 0) {
    console.log("[check-pr-terminal-state] informativo (#10439): PR(s) de outra sessão, autoria alheia confirmada:");
    for (const a of verdict.alienConfirmed) {
      console.log(`  ${prLabel(a)} — branch ${a.headRefName} (${a.source})`);
    }
  }

  if (verdict.notEvaluated.length > 0) {
    console.error(
      "[check-pr-terminal-state] aviso (#10618): PR(s) registrado(s) em plan.json num repo NÃO consultado — estado desconhecido (não lido como fechado):",
    );
    for (const d of verdict.notEvaluated) {
      console.error(`  ${prLabel(d)} — issue(s) ${d.issueNumbers.map((n) => `${d.repo}#${n}`).join(", ")}`);
    }
  }

  if (verdict.status === "ok") {
    console.log(
      ressalva
        ? `ok PARCIAL — nenhum PR aberto sem estado terminal registrado nos repos consultados (${openPrs.length} PR(s) aberto(s) checado(s)); ${ressalva}`
        : `ok — nenhum PR aberto sem estado terminal registrado (${openPrs.length} PR(s) aberto(s) checado(s))`,
    );
    process.exit(0);
  }

  if (verdict.registeredNotTerminal.length > 0) {
    console.error("[check-pr-terminal-state] PR(s) registrado(s) em plan.json ainda aberto(s) sem status terminal:");
    for (const d of verdict.registeredNotTerminal) {
      const issuesList = d.issueNumbers.map((n) => (d.repo ? `${d.repo}#${n}` : `#${n}`)).join(", ");
      const statusList = d.statuses.map((s) => s ?? "(sem status)").join(", ");
      console.error(`  ${prLabel(d)} — issue(s) ${issuesList}, status atual: ${statusList}`);
    }
  }

  if (verdict.unregisteredCandidates.length > 0) {
    console.error(
      "[check-pr-terminal-state] aviso (não reprova, #10430): PR(s) aberto(s) em branch desta linha de skills (develop/overnight/fix) SEM registro em plan.json — candidato(s) pra revisão humana, autoria não confirmada (pode ser de outra sessão):",
    );
    for (const c of verdict.unregisteredCandidates) {
      console.error(`  ${prLabel(c)} — branch ${c.headRefName}${c.retida ? " (retida para o editor)" : ""}`);
    }
  }

  const exitCode = verdictExitCode(verdict);
  if (exitCode === 1) {
    console.error(
      "[check-pr-terminal-state] → confirme o estado real de cada PR (gh pr view N), mergeie/feche/atualize plan.json com o status correto (ex.: `retida-para-editor` para PR retida, #10430) antes de escrever o relatório final.",
    );
    if (ressalva) console.error(`[check-pr-terminal-state] ${ressalva}`);
  } else {
    console.log(
      ressalva
        ? `ok PARCIAL — nenhuma divergência confirmada nos repos consultados (só candidato(s) listado(s) acima, informativo); ${ressalva}`
        : "ok — nenhuma divergência confirmada (só candidato(s) listado(s) acima, informativo)",
    );
  }
  process.exit(exitCode);
}
