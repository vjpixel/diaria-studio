#!/usr/bin/env node
/**
 * scripts/hubs-weekly-regen.ts (#8906)
 *
 * Orquestrador do regen automático semanal dos hubs temáticos — substitui a
 * task `Diaria-Hub-Pages-Build` (#5754/#6267, `enabled: false`, nunca
 * funcionou de verdade) por um caminho que de fato chega até produção,
 * seguindo as decisões do editor registradas em #8906:
 *
 *   (a) só regenera DADOS (lista de fontes, `UPDATED_DATE` = "dados
 *       atualizados em"), nunca prosa — quando o volume de edições novas
 *       desde a última revisão de prosa cruza um limiar, abre 1 issue de
 *       revisão por hub (ver `scripts/lib/hubs-weekly-regen.ts`);
 *   (b) PR a partir de worktree isolado (`git worktree add`, NUNCA escreve
 *       nem commita na checkout compartilhada — ver §"Isolamento" abaixo),
 *       auto-merge com testes verdes; o deploy do Worker `arquivo` já é
 *       automático no push a `master` (`.github/workflows/deploy-arquivo.yml`,
 *       #4105) — este script não chama `wrangler deploy`;
 *   (c) nunca passa pelo gate `--check-facts` (caminho de prosa manual) —
 *       roda `build-hub-page.ts --all --skip-fact-check` sempre.
 *
 * **Isolamento (review da PR #8922, findings P1 #2/#3).** A checkout
 * compartilhada (`ROOT`, onde outras sessões/tasks podem estar rodando ao
 * mesmo tempo — #4459/#6971/#7730) NUNCA recebe `git checkout -b`, escrita
 * de `.generated.json`/`UPDATED_DATE`, nem commit deste script. Todo o
 * trabalho sujo (regen write, build, testes, commit, push, PR) acontece num
 * `git worktree add` dedicado (mesmo padrão do overnight/develop,
 * `.claude/worktrees/`), removido em `finally` — sucesso ou falha, a
 * checkout principal fica exatamente como estava antes da execução. Isso
 * também fecha o finding P1 #3: como as escritas só existem dentro do
 * worktree descartável, uma falha de build/teste não deixa NADA sujo pra
 * trás, cumprindo de verdade a promessa "sem commitar nada — nunca deixa a
 * checkout suja" (antes, "não commitar" não implicava "não escrever" — a
 * escrita acontecia direto em `ROOT`).
 *
 * Falha em qualquer etapa (regen, build, typecheck, testes, git/gh) —
 * inclusive uma exceção não-prevista na fase de leitura/diff — abre alarme
 * via `scripts/lib/alarm-issues.ts` e o script sai com código != 0. A fase
 * de leitura/diff/decisão de todos os hubs roda dentro de um único
 * try/catch (finding P2 #4 da PR #8922) — qualquer exceção ali também
 * aciona o alarme em vez de crashar sem rastro.
 *
 * **Uso:**
 *   npx tsx scripts/hubs-weekly-regen.ts                # roda de verdade
 *   npx tsx scripts/hubs-weekly-regen.ts --dry-run       # só imprime o plano, não escreve/commita/mergeia
 *   npx tsx scripts/hubs-weekly-regen.ts --session-id ID # obrigatório fora de --dry-run (merge lock, #8906 nota do editor)
 *
 * **Fail-soft (mesmo padrão de `hub-staleness-check.ts`/#2643):** sem o
 * junction `data/` (sessão cloud, clone fresco, ou este próprio worktree de
 * implementação — `loadPosts()` precisa de `data/beehiiv-cache/posts`),
 * imprime aviso e sai 0 — "nada a checar" nesse ambiente, nunca erro.
 *
 * **Nunca rodado ao vivo nesta unidade** (worktree isolado sem `data/`,
 * sem `gh` autenticado contra o repo real neste ambiente de dispatch) —
 * validado só via `test/hubs-weekly-regen.test.ts` (lógica pura) e leitura
 * cuidadosa do I/O glue, mesmo padrão de admissão de `hub-drift-check.ts`
 * (ver docstring de lá). Arme via `scripts/setup-systemd-timers.ts` na
 * checkout do "300" é ação POSTERIOR do editor — não incluído aqui.
 */
import { existsSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import {
  HUB_KEYWORD_PATTERNS,
  loadPosts,
  collectHubSources,
  mergeManualHubSources,
  computeHubSourcesDiff,
  writeGeneratedHubSources,
  type HubSourceEntry,
} from "./generate-hub-sources.ts";
import {
  planHubRegen,
  bumpUpdatedDateLine,
  decideProseAlarm,
  ensureProseReviewBaseline,
  emptyProseReviewState,
  mergeHubsRegenPr,
  type ProseReviewState,
  type HubRegenPlan,
} from "./lib/hubs-weekly-regen.ts";
import {
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  defaultAlarmGhRun,
  type AlarmFinding,
} from "./lib/alarm-issues.ts";
import { createRealTrainRunner } from "./lib/merge-train-live.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HUBS_DIR = resolve(ROOT, "scripts/lib/hubs");
const PROSE_STATE_PATH = resolve(ROOT, "data", "hubs", "prose-review-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "hubs", "weekly-regen-alarm-issues.json");
const LOG_PREFIX = "[hubs-weekly-regen]";
const BRANCH_PREFIX = "hubs/weekly-regen-";
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Estado de revisão de prosa (persistência) ──────────────────────────────

function loadProseReviewState(path: string = PROSE_STATE_PATH): ProseReviewState {
  if (!existsSync(path)) return emptyProseReviewState();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProseReviewState;
  } catch {
    return emptyProseReviewState();
  }
}

function saveProseReviewState(state: ProseReviewState, path: string = PROSE_STATE_PATH): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Lê o `UPDATED_DATE` hand-written já commitado de `scripts/lib/hubs/{slug}.ts`
 * — usado como baseline dia-0 de `ensureProseReviewBaseline` (#8906). */
function readCurrentUpdatedDate(hubsDir: string, slug: string): string {
  const path = resolve(hubsDir, `${slug}.ts`);
  const content = readFileSync(path, "utf8");
  const match = /^const UPDATED_DATE = "(\d{4}-\d{2}-\d{2})";$/m.exec(content);
  if (!match) throw new Error(`readCurrentUpdatedDate: UPDATED_DATE não encontrado em ${path}`);
  return match[1];
}

function toAlarmFinding(check: string, fingerprint: string, title: string, body: string): AlarmFinding {
  return { check, fingerprint, family: "estado", title, body, labels: ["bug"], priority: "P2" };
}

/** Reconcilia a lista de achados PENDENTES desta execução contra o estado
 * persistido — mesmo padrão de `home-meta-check.ts`/`hub-drift-check.ts`
 * (`applyAlarmReconciliation`, não `ensureAlarmIssue` direto: aquela também
 * fecha/comenta issues de achados que já pararam de reproduzir). Chamada
 * UMA vez por execução, com a lista completa de achados pendentes
 * (prosa-defasada por hub + falha, se houver) — nunca em loop achado-a-
 * achado, senão um achado ausente numa 2ª chamada seria lido como "resolvido"
 * incorretamente. */
function reconcileAlarms(pending: AlarmFinding[]): void {
  const state = existsSync(ALARM_ISSUES_STATE_PATH) ? loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH) : emptyAlarmIssuesState();
  const { nextState } = applyAlarmReconciliation(pending, state, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    run: defaultAlarmGhRun,
  });
  saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
}

function alarmFailure(reason: string, detail: string, alsoWith: AlarmFinding[] = []): void {
  process.stderr.write(`${LOG_PREFIX} FALHA: ${reason}\n${detail}\n`);
  reconcileAlarms([
    ...alsoWith,
    toAlarmFinding(
      "hubs-weekly-regen",
      `falha:${reason}`,
      `[diar.ia.br] regen semanal de hubs falhou — ${reason}`,
      [
        "Achado automático de `scripts/hubs-weekly-regen.ts` (task",
        "`Diaria-Hub-Weekly-Regen`, #8906).",
        "",
        detail,
        "",
        "Nenhuma mudança foi commitada — o worktree isolado do job foi",
        "descartado, a checkout compartilhada nunca foi tocada.",
        "Investigar o log completo da execução antes de reativar o timer.",
      ].join("\n"),
    ),
  ]);
}

function proseAlarmFinding(slug: string): AlarmFinding {
  return toAlarmFinding(
    slug,
    "prosa-defasada",
    `[diar.ia.br] hub "${slug}" acumulou edições novas — revisar prosa`,
    [
      "Achado automático do regen semanal (`scripts/hubs-weekly-regen.ts`, #8906).",
      "",
      `O hub \`${slug}\` recebeu edições novas desde a última revisão de prosa`,
      "acima do limiar (`HUB_PROSE_REVIEW_THRESHOLD_EDITIONS`,",
      "`scripts/lib/hubs-weekly-regen.ts`) — o dataset já foi regenerado",
      "automaticamente (só dados), mas a prosa (`sections`/FAQ) pode não",
      "refletir mais a cobertura recente.",
      "",
      `Revisar scripts/lib/hubs/${slug}.ts manualmente e, depois de reconciliar`,
      "a prosa, atualizar a entrada correspondente em",
      "`data/hubs/prose-review-state.json` com a data da revisão.",
    ].join("\n"),
  );
}

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

interface HubPlan {
  readonly slug: string;
  readonly rows: readonly HubSourceEntry[];
  readonly plan: HubRegenPlan;
}

/** Fase 1 — só leitura: regen de fontes + diff + decisão por hub, contra a
 * checkout `ROOT` (nunca escreve nada aqui). Lança em qualquer erro —
 * `main()` envolve a chamada em try/catch (finding P2 #4 da PR #8922). */
function planAllHubs(today: string): { hubPlans: HubPlan[]; proseAlarmSlugs: string[]; proseState: ProseReviewState } {
  const posts = loadPosts();
  let proseState = loadProseReviewState();
  const hubPlans: HubPlan[] = [];
  const proseAlarmSlugs: string[] = [];

  for (const slug of Object.keys(HUB_KEYWORD_PATTERNS)) {
    const { rows: collected, warnings } = collectHubSources(posts, HUB_KEYWORD_PATTERNS[slug]);
    for (const w of warnings) process.stderr.write(`${LOG_PREFIX} ⚠ ${slug}: ${w}\n`);

    const outPath = resolve(HUBS_DIR, `${slug}-sources.generated.json`);
    const existing: HubSourceEntry[] = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as HubSourceEntry[]) : [];
    const rows = mergeManualHubSources(existing, collected);
    const diff = computeHubSourcesDiff(existing, rows);
    const plan = planHubRegen(slug, diff, today);

    const currentUpdatedDate = readCurrentUpdatedDate(HUBS_DIR, slug);
    proseState = ensureProseReviewBaseline(proseState, slug, currentUpdatedDate);
    const proseDecision = decideProseAlarm(proseState, slug, rows.map((r) => r.date), currentUpdatedDate);
    if (proseDecision.alarm) proseAlarmSlugs.push(slug);

    process.stderr.write(
      plan.hasDataChange
        ? `${LOG_PREFIX} ${slug}: ${diff.added.length} nova(s), ${diff.changed.length} alterada(s), ${diff.removed.length} removida(s).\n`
        : `${LOG_PREFIX} ${slug}: sem mudança de dados, pulando.\n`,
    );
    hubPlans.push({ slug, rows, plan });
  }

  return { hubPlans, proseAlarmSlugs, proseState };
}

/** Cria um `git worktree` dedicado a partir de `master`, com `node_modules`
 * symlinkado do checkout principal (mesmo padrão de worktree do
 * overnight/develop — `node_modules/` próprio não é reinstalado, só
 * referenciado). Caller é responsável por `removeWorktree` em `finally`. */
function createWorktree(branch: string): string {
  const workRoot = join(tmpdir(), `diaria-hubs-weekly-regen-${branch.replace(/\//g, "-")}`);
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
  run("git", ["worktree", "add", "-b", branch, workRoot, "master"], ROOT);
  const nodeModulesTarget = resolve(ROOT, "node_modules");
  if (existsSync(nodeModulesTarget)) {
    symlinkSync(nodeModulesTarget, join(workRoot, "node_modules"), "dir");
  }
  return workRoot;
}

function removeWorktree(workRoot: string): void {
  try {
    run("git", ["worktree", "remove", "--force", workRoot], ROOT);
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} aviso: git worktree remove falhou (${(e as Error).message}) — limpando o diretório direto.\n`);
    if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
    try {
      run("git", ["worktree", "prune"], ROOT);
    } catch {
      // best-effort — não deixar a falha de limpeza mascarar o resultado real da execução.
    }
  }
}

/**
 * Parseia os args de CLI deste script (#8932). Isolado do `main()` pra dar
 * cobertura de teste sem depender de `data/` (o script inteiro sai cedo se
 * o junction `data/` estiver ausente, então testar via processo real não
 * exercita este parsing em CI/worktree — ver `test/hubs-weekly-regen.test.ts`).
 */
export function parseHubsWeeklyRegenArgs(argv: string[]): { dryRun: boolean; sessionId: string | undefined } {
  return {
    dryRun: hasFlag(argv, "dry-run"),
    sessionId: getArg(argv, "session-id") || undefined,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { dryRun, sessionId } = parseHubsWeeklyRegenArgs(argv);

  const cachePath = resolve(ROOT, "data", "beehiiv-cache", "posts");
  if (!existsSync(cachePath)) {
    process.stderr.write(
      `${LOG_PREFIX} data/beehiiv-cache/posts ausente (sem junction data/ nesta sessão) — nada a checar, saindo 0.\n`,
    );
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  let hubPlans: HubPlan[];
  let proseAlarmSlugs: string[];
  let proseState: ProseReviewState;
  try {
    ({ hubPlans, proseAlarmSlugs, proseState } = planAllHubs(today));
  } catch (e) {
    alarmFailure("regen-scan", `Falha na fase de leitura/diff dos hubs: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  saveProseReviewState(proseState);
  const proseFindings = proseAlarmSlugs.map(proseAlarmFinding);
  const touched = hubPlans.filter((h) => h.plan.hasDataChange);

  if (dryRun) {
    if (proseAlarmSlugs.length > 0) {
      process.stderr.write(`${LOG_PREFIX} [dry-run] abriria issue de revisão de prosa para: ${proseAlarmSlugs.join(", ")}.\n`);
    }
    if (touched.length === 0) {
      process.stderr.write(`${LOG_PREFIX} nenhum hub com mudança de dados — nada a commitar.\n`);
      return;
    }
    process.stderr.write(`${LOG_PREFIX} [dry-run] hubs que seriam regenerados: ${touched.map((h) => h.slug).join(", ")}.\n`);
    return;
  }

  if (touched.length === 0) {
    // Sem mudança de dados: só reconcilia os achados de prosa (se houver) e sai.
    reconcileAlarms(proseFindings);
    process.stderr.write(`${LOG_PREFIX} nenhum hub com mudança de dados — nada a commitar.\n`);
    return;
  }

  if (!sessionId) {
    alarmFailure(
      "session-id-ausente",
      "Regen com mudança de dados exige --session-id pro merge lock (#8906, nota do editor) — abortando antes de criar o worktree.",
      proseFindings,
    );
    process.exitCode = 1;
    return;
  }

  const touchedSlugs = touched.map((h) => h.slug);
  // Sufixo de horário (HHmm), não só a data — uma 2ª tentativa no mesmo dia
  // (retry pós-falha de build/git/gh) pega um nome de branch novo em vez de
  // colidir no `git checkout -b`/push (achado P3 do review da PR #8922).
  const branch = `${BRANCH_PREFIX}${today}-${new Date().toISOString().slice(11, 16).replace(":", "")}`;

  // ─── Todo o trabalho sujo (escrita, build, testes, git, gh) acontece só
  // dentro do worktree isolado — a checkout compartilhada (ROOT) nunca é
  // escrita nem commitada por este bloco (review PR #8922, findings P1 #2/#3). ───
  let workRoot: string;
  try {
    workRoot = createWorktree(branch);
  } catch (e) {
    alarmFailure("git-worktree-add", `Não consegui criar o worktree isolado: ${(e as Error).message}`, proseFindings);
    process.exitCode = 1;
    return;
  }

  try {
    const workHubsDir = resolve(workRoot, "scripts/lib/hubs");
    for (const { slug, rows, plan } of touched) {
      const outPath = resolve(workHubsDir, `${slug}-sources.generated.json`);
      writeGeneratedHubSources(outPath, rows, { dryRun: false });
      const hubFilePath = resolve(workHubsDir, `${slug}.ts`);
      const hubFileContent = readFileSync(hubFilePath, "utf8");
      writeFileSync(hubFilePath, bumpUpdatedDateLine(hubFileContent, plan.newUpdatedDate!), "utf8");
    }

    // ─── Build + validação (dentro do worktree) ──────────────────────────
    try {
      run(process.execPath, ["--import", "tsx", "scripts/build-hub-page.ts", "--all", "--skip-fact-check"], workRoot);
      run(
        process.execPath,
        ["--import", "tsx", "--test", "test/hub-page-drift.test.ts", "test/build-hub-page.test.ts", "test/hub-registry-completeness.test.ts"],
        workRoot,
      );
      run("npx", ["tsc", "--noEmit"], workRoot);
    } catch (e) {
      alarmFailure("build-ou-testes", `Build/testes falharam após regen de ${touchedSlugs.join(", ")}: ${(e as Error).message}`, proseFindings);
      process.exitCode = 1;
      return;
    }

    // ─── Git: commit + push + PR + merge (dentro do worktree) ────────────
    try {
      run("git", ["add", "scripts/lib/hubs/"], workRoot);
      run("git", ["commit", "-m", `chore(hubs): regen semanal automático — ${touchedSlugs.join(", ")}\n\nRefs #8906`], workRoot);
      run("git", ["push", "-u", "origin", branch], workRoot);
      const prBody = [
        "Regen automático semanal (`scripts/hubs-weekly-regen.ts`, #8906).",
        "",
        `Hubs com dados novos: ${touchedSlugs.join(", ")}.`,
        "",
        "Só dados (lista de fontes + `UPDATED_DATE`) — nenhuma prosa foi tocada.",
        "Fact-check pulado de propósito (`--skip-fact-check`, decisão do editor",
        "#8906 item c — gate de prosa continua valendo só pra edição manual).",
        "",
        "Refs #8906 (issue só fecha depois da 1ª sexta com evidência completa —",
        "ver critério de fechamento no corpo da issue).",
        "",
        "🤖 Generated with Claude Code",
      ].join("\n");
      const prUrl = run("gh", ["pr", "create", "--title", `chore(hubs): regen semanal — ${touchedSlugs.join(", ")}`, "--body", prBody, "--base", "master"], workRoot);
      const prNumberMatch = /\/pull\/(\d+)/.exec(prUrl);
      const prNumber = prNumberMatch ? prNumberMatch[1] : undefined;
      if (!prNumber) throw new Error(`não consegui extrair o número da PR de "${prUrl}"`);

      // #8923: merge SÍNCRONO — espera o CI real, só mergeia com veredito
      // "pass" confirmado, lock cobre a espera inteira (não só o comando
      // que agendava o auto-merge). Ver docstring de `mergeHubsRegenPr`.
      const mergeResult = await mergeHubsRegenPr(createRealTrainRunner(ROOT), prNumber, { sessionId });
      if (!mergeResult.ok) {
        alarmFailure("ci-vermelho-ou-merge-falhou", `PR #${prNumber} não foi mergeada: ${mergeResult.error}`, proseFindings);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`${LOG_PREFIX} PR #${prNumber} mergeada (squash síncrono, confirmado via gh pr view).\n`);
      reconcileAlarms(proseFindings);
    } catch (e) {
      alarmFailure("git-ou-gh", `Falha no fluxo de commit/PR/merge: ${(e as Error).message}`, proseFindings);
      process.exitCode = 1;
    }
  } finally {
    removeWorktree(workRoot);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro não tratado: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
