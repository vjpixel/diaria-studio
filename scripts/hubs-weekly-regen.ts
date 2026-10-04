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
 * **`--dry-run` faz `git fetch`/`git worktree add` (#9019).** Desde que o
 * plano passou a ser calculado contra o mesmo `workRoot` que seria escrito
 * (ver `planAllHubs` abaixo), até o `--dry-run` precisa desse worktree
 * temporário pra reportar um plano fiel a `origin/master` — então
 * `--dry-run` toca rede (fetch) e cria/descarta um worktree+branch locais.
 * O que continua garantido é "nunca escreve/commita/mergeia/abre issue":
 * nenhum arquivo do worktree é modificado, nenhum commit/push/PR acontece, e
 * `alarmFailure` pula `reconcileAlarms` (sem `gh issue create`/`comment`)
 * quando `dryRunActive` — uma falha em `--dry-run` só loga e sai != 0.
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
import { existsSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
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
import type { RawCachedPost } from "./generate-arquivo-titles.ts";
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
import { hubCoverageDate } from "./lib/shared/hub-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROSE_STATE_PATH = resolve(ROOT, "data", "hubs", "prose-review-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "hubs", "weekly-regen-alarm-issues.json");
const LOG_PREFIX = "[hubs-weekly-regen]";
const BRANCH_PREFIX = "hubs/weekly-regen-";
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** Paths que ENTRAM no commit do regen semanal (#8948). O passo de build
 * (`build-hub-page.ts --all`) reescreve tanto o dataset em
 * `scripts/lib/hubs/*-sources.generated.json` quanto o HTML gerado do
 * Worker em `workers/arquivo/src/hubs/*.generated.ts` — os DOIS precisam
 * entrar no commit, senão o job "Hub page drift" (`test/hub-page-drift.test.ts`,
 * `pr-checks.yml`) nunca vê os `.generated.ts` commitados batendo com o
 * dataset novo e falha em toda execução (achado #8948: só o primeiro path
 * era staged). Exportado pra `test/hubs-weekly-regen-script.test.ts`
 * afirmar que o conjunto staged tem paridade com o que
 * `test/hub-page-drift.test.ts` de fato audita. */
export const HUBS_GIT_ADD_PATHS = ["scripts/lib/hubs/", "workers/arquivo/src/hubs/"] as const;

// ─── Estado de revisão de prosa (persistência) ──────────────────────────────

/** `warn` é injetável (#8949 item 3, teste sem depender de `process.stderr`
 * real) — default escreve no stderr do processo. Estado corrompido
 * (`JSON.parse` falho) sempre EMITE aviso antes de resetar pra vazio: antes
 * disso o reset acontecia em silêncio e, como `main()` re-semeia e sobrescreve
 * o arquivo (`saveProseReviewState`) logo depois, o editor perdia as datas de
 * revisão de prosa já registradas sem nenhum sinal. */
export function loadProseReviewState(
  path: string = PROSE_STATE_PATH,
  warn: (msg: string) => void = (msg) => process.stderr.write(msg),
): ProseReviewState {
  if (!existsSync(path)) return emptyProseReviewState();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProseReviewState;
  } catch (e) {
    warn(
      `${LOG_PREFIX} aviso: estado de revisão de prosa corrompido em ${path} (${(e as Error).message}) — resetando para vazio (datas de revisão registradas serão perdidas).\n`,
    );
    return emptyProseReviewState();
  }
}

export function saveProseReviewState(state: ProseReviewState, path: string = PROSE_STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
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

/** Reconstrói os achados `prosa-defasada` ATUALMENTE abertos a partir do
 * estado persistido (#9019, review PR #9047 finding 1) — usado pelos
 * catches de falha em que `proseAlarmSlugs` não está disponível (worktree
 * indisponível, ou o próprio `planAllHubs` lançou — #9152), que não têm
 * como recalcular se cada hub ainda cruza o limiar. Sem isso, `alarmFailure(..., [])` reconciliaria com uma lista de
 * achados de prosa VAZIA, e `applyAlarmReconciliation` leria "nenhum hub
 * defasado neste run" — avançando o `missingStreak` de toda issue de prosa
 * aberta rumo ao auto-close (`CLOSE_ALARM_ISSUE_AFTER_RUNS`), mesmo que o
 * hub continue genuinamente defasado; só faltou saber. `statePath`
 * injetável só pra teste. */
export function openProseFindings(statePath: string = ALARM_ISSUES_STATE_PATH): AlarmFinding[] {
  if (!existsSync(statePath)) return [];
  const state = loadAlarmIssuesState(statePath);
  const suffix = ":prosa-defasada";
  const openSlugs = Object.entries(state)
    .filter(([key, entry]) => key.endsWith(suffix) && !entry.closedAt)
    .map(([key]) => key.slice(0, -suffix.length));
  return openSlugs.map(proseAlarmFinding);
}

/** #9019, review PR #9047 finding 2: `--dry-run` nunca escreve — nem em
 * disco (já garantido pelos early-returns de `main()`) nem em serviços
 * externos. Sem esta flag, uma falha de `createWorktree` durante um
 * `--dry-run` (agora possível desde que o worktree passou a nascer ANTES
 * do planejamento, pra ler o mesmo `hubsDir` que seria escrito) chamaria
 * `reconcileAlarms` -> `gh issue create`/`comment`, contrariando o próprio
 * contrato do modo. Setada só por `main()`, no início, a partir do arg
 * já parseado. */
let dryRunActive = false;

function alarmFailure(reason: string, detail: string, alsoWith: AlarmFinding[] = []): void {
  process.stderr.write(`${LOG_PREFIX} FALHA: ${reason}\n${detail}\n`);
  if (dryRunActive) {
    process.stderr.write(`${LOG_PREFIX} [dry-run] não reconciliando issues de alarme (nenhuma escrita externa em --dry-run).\n`);
    return;
  }
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

/** Fase 1 — só leitura: regen de fontes + diff + decisão por hub. `hubsDir`
 * é OBRIGATÓRIO (#9019, review PR #9047 finding 3 — um default apontando de
 * volta pra checkout compartilhada reintroduziria o bug em silêncio se
 * algum call site futuro esquecesse de passá-lo) e é o diretório de onde
 * `existing`/`currentUpdatedDate` são lidos — deve ser o mesmo
 * `workRoot/scripts/lib/hubs` onde o plano depois é ESCRITO: a checkout
 * compartilhada (`ROOT`) pode estar defasada em relação a `origin/master`
 * (a razão de #8949 item 4 ter passado a criar o worktree a partir de
 * `origin/master`), então planejar contra a checkout compartilhada e
 * escrever no worktree misturava um `existing`/`currentUpdatedDate` velhos
 * com uma base nova — perdendo fontes `manual: true` adicionadas depois do
 * último sync do checkout, ou regredindo `UPDATED_DATE`. O cache de posts
 * (`loadPosts()`) continua lido de `ROOT/data` — não é escrito por este
 * script, então não sofre da mesma defasagem de branch. `posts`/`slugs`/
 * `patterns` são injetáveis só pra teste (`test/hubs-weekly-regen-script.test.ts`,
 * que não pode depender do junction `data/` real nem de todo slug de
 * `HUB_KEYWORD_PATTERNS` ter fixture em disco) — `main()` sempre usa os
 * defaults dos três. Lança em qualquer erro, inclusive um `slug` sem
 * `pattern` correspondente — `main()` envolve a chamada em try/catch
 * (finding P2 #4 da PR #8922). */
export function planAllHubs(
  today: string,
  hubsDir: string,
  posts: RawCachedPost[] = loadPosts(),
  slugs: string[] = Object.keys(HUB_KEYWORD_PATTERNS),
  patterns: Record<string, RegExp> = HUB_KEYWORD_PATTERNS,
): { hubPlans: HubPlan[]; proseAlarmSlugs: string[]; proseState: ProseReviewState } {
  let proseState = loadProseReviewState();
  const hubPlans: HubPlan[] = [];
  const proseAlarmSlugs: string[] = [];

  for (const slug of slugs) {
    const pattern = patterns[slug];
    if (!pattern) throw new Error(`planAllHubs: nenhum pattern registrado para o slug "${slug}"`);
    const { rows: collected, warnings } = collectHubSources(posts, pattern);
    for (const w of warnings) process.stderr.write(`${LOG_PREFIX} ⚠ ${slug}: ${w}\n`);

    const outPath = resolve(hubsDir, `${slug}-sources.generated.json`);
    const existing: HubSourceEntry[] = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as HubSourceEntry[]) : [];
    const rows = mergeManualHubSources(existing, collected);
    const diff = computeHubSourcesDiff(existing, rows);
    const coverageDate = hubCoverageDate(rows);
    const currentUpdatedDate = readCurrentUpdatedDate(hubsDir, slug);
    const plan = planHubRegen(slug, diff, today, coverageDate, currentUpdatedDate);

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

type PlanAllHubsResult = ReturnType<typeof planAllHubs>;

/** Roda `planAllHubs` e, se ele lançar, dispara o alarme `regen-scan`
 * preservando os achados `prosa-defasada` já abertos (#9152) — sem o 3º
 * argumento, `alarmFailure` reconciliaria com lista de prosa vazia e cada
 * semana de falha de scan avançaria o `missingStreak` rumo ao auto-close
 * de toda issue de prosa aberta, mesmo com o hub ainda defasado (o #9019
 * só tinha corrigido o catch do `git-worktree-add`). Devolve `null` na
 * falha. `deps` injetável só pra teste. */
export function planAllHubsOrAlarm(
  today: string,
  hubsDir: string,
  deps: {
    plan?: (today: string, hubsDir: string) => PlanAllHubsResult;
    alarm?: (reason: string, detail: string, alsoWith: AlarmFinding[]) => void;
    openProse?: () => AlarmFinding[];
  } = {},
): PlanAllHubsResult | null {
  const { plan = planAllHubs, alarm = alarmFailure, openProse = openProseFindings } = deps;
  try {
    return plan(today, hubsDir);
  } catch (e) {
    alarm("regen-scan", `Falha na fase de leitura/diff dos hubs: ${(e as Error).message}`, openProse());
    return null;
  }
}

/** Cria um `git worktree` dedicado a partir de `origin/master` (nunca do
 * `master` local sem fetch — #8949 item 4: sem isso, se o checkout
 * compartilhado não tiver sido atualizado entre execuções semanais, a PR
 * da semana seguinte parte de uma base velha e diverge do que já foi
 * mergeado, gerando conflito/timeout de CI na execução seguinte), com
 * `node_modules` symlinkado do checkout principal (mesmo padrão de
 * worktree do overnight/develop — `node_modules/` próprio não é
 * reinstalado, só referenciado). `gitRun` é injetável (default `run`) pra
 * teste sem depender de rede/gh real. Caller é responsável por
 * `removeWorktree` em `finally`. */
export function createWorktree(
  branch: string,
  gitRun: (cmd: string, args: string[], cwd: string) => string = run,
): string {
  const workRoot = join(tmpdir(), `diaria-hubs-weekly-regen-${branch.replace(/\//g, "-")}`);
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
  gitRun("git", ["fetch", "origin", "master"], ROOT);
  gitRun("git", ["worktree", "add", "-b", branch, workRoot, "origin/master"], ROOT);
  try {
    const nodeModulesTarget = resolve(ROOT, "node_modules");
    if (existsSync(nodeModulesTarget)) {
      symlinkSync(nodeModulesTarget, join(workRoot, "node_modules"), "dir");
    }
  } catch (e) {
    // #9019, review PR #9047 finding 6: `worktree add` acima já criou o
    // worktree + branch quando o symlink falha — o caller só chega no
    // `finally`/`removeWorktree` DEPOIS de `createWorktree` retornar com
    // sucesso, então sem limpar aqui os dois vazariam a cada falha de
    // symlink (best-effort, mesmo padrão de `removeWorktree`).
    try {
      gitRun("git", ["worktree", "remove", "--force", workRoot], ROOT);
    } catch {
      // best-effort
    }
    try {
      gitRun("git", ["branch", "-D", branch], ROOT);
    } catch {
      // best-effort
    }
    throw e;
  }
  return workRoot;
}

/** Remove o worktree isolado e o branch local que `createWorktree` criou
 * nele (#9019: agora o worktree nasce ANTES de saber se há mudança de
 * dados — planAllHubs roda dentro dele — então toda execução, inclusive
 * dry-run/sem-mudança/session-id-ausente, cria um branch local que precisa
 * ser descartado; o remoto só existe se o push tiver acontecido, então o
 * `git branch -D` aqui é sempre best-effort). */
function removeWorktree(workRoot: string, branch: string): void {
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
  try {
    run("git", ["branch", "-D", branch], ROOT);
  } catch (e) {
    // #9019, review PR #9047 finding 7: best-effort (branch pode já não
    // existir — ex: worktree add falhou antes de criá-lo), mas nunca mudo:
    // desde que todo run cria um branch (inclusive dry-run/sem-mudança), um
    // `git worktree remove` que também falhou acima deixaria o branch preso
    // (git recusa `-D` em branch com worktree associado) sem nenhum sinal.
    process.stderr.write(`${LOG_PREFIX} aviso: git branch -D ${branch} falhou (${(e as Error).message}).\n`);
  }
}

export const HUBS_WEEKLY_REGEN_USAGE =
  "Uso: npx tsx scripts/hubs-weekly-regen.ts [--dry-run] [--session-id <id>] [--help]\n" +
  "  --dry-run         planeja sem commit/push/deploy\n" +
  "  --session-id <id> sessão dona do merge lock (obrigatório em regen com mudança de dados)\n" +
  "  --help, -h        mostra esta ajuda e sai sem executar o regen\n";

/**
 * Parseia os args de CLI deste script (#8932). Isolado do `main()` pra dar
 * cobertura de teste sem depender de `data/` (o script inteiro sai cedo se
 * o junction `data/` estiver ausente, então testar via processo real não
 * exercita este parsing em CI/worktree — ver `test/hubs-weekly-regen.test.ts`).
 */
export function parseHubsWeeklyRegenArgs(
  argv: string[],
): { dryRun: boolean; sessionId: string | undefined; help: boolean } {
  return {
    // #8931: `--help`/`-h` é modo informativo — sem isso o regen rodava de verdade.
    help: argv.includes("--help") || argv.includes("-h"),
    dryRun: hasFlag(argv, "dry-run"),
    sessionId: getArg(argv, "session-id") || undefined,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { dryRun, sessionId, help } = parseHubsWeeklyRegenArgs(argv);
  if (help) {
    process.stdout.write(HUBS_WEEKLY_REGEN_USAGE);
    return;
  }
  dryRunActive = dryRun;

  const cachePath = resolve(ROOT, "data", "beehiiv-cache", "posts");
  if (!existsSync(cachePath)) {
    process.stderr.write(
      `${LOG_PREFIX} data/beehiiv-cache/posts ausente (sem junction data/ nesta sessão) — nada a checar, saindo 0.\n`,
    );
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  // Sufixo de horário (HHmm) + PID, não só a data — uma 2ª tentativa no
  // mesmo dia (retry pós-falha de build/git/gh) pega um nome de branch novo
  // em vez de colidir no `git checkout -b`/push (achado P3 do review da PR
  // #8922); o PID entra desde #9019 (review PR #9047 finding 5) porque
  // agora todo run cria um worktree — inclusive `--dry-run` — e dois
  // processos disparados no mesmo minuto (timer + dry-run manual, ou dois
  // retries em sequência rápida) colidiriam no mesmo `workRoot` de
  // `createWorktree`, que começa com `rmSync` no path derivado do branch.
  const branch = `${BRANCH_PREFIX}${today}-${new Date().toISOString().slice(11, 16).replace(":", "")}-${process.pid}`;

  // ─── Worktree criado JÁ NO INÍCIO (#9019): o plano precisa ler
  // `existing`/`currentUpdatedDate` do mesmo `workRoot` de `origin/master`
  // onde depois escreve — plantar contra o `ROOT` compartilhado (que pode
  // estar defasado) e escrever no worktree perdia fontes manuais/regredia
  // `UPDATED_DATE` quando os dois checkouts divergiam. Isso vale pra TODA
  // execução, inclusive `--dry-run` e o caminho sem mudança de dados — só
  // assim o plano relatado é fiel ao que de fato seria commitado. A
  // checkout compartilhada (ROOT) nunca é escrita nem commitada por este
  // script (review PR #8922, findings P1 #2/#3) — só usada como origem do
  // `git worktree add`/`git branch -D` de limpeza. ───
  let workRoot: string;
  try {
    workRoot = createWorktree(branch);
  } catch (e) {
    alarmFailure("git-worktree-add", `Não consegui criar o worktree isolado: ${(e as Error).message}`, openProseFindings());
    process.exitCode = 1;
    return;
  }

  try {
    const planned = planAllHubsOrAlarm(today, resolve(workRoot, "scripts/lib/hubs"));
    if (!planned) {
      process.exitCode = 1;
      return;
    }
    const { hubPlans, proseAlarmSlugs, proseState } = planned;

    const proseFindings = proseAlarmSlugs.map(proseAlarmFinding);
    const touched = hubPlans.filter((h) => h.plan.hasDataChange);

    if (dryRun) {
      // #8949 item 2: `--dry-run` nunca escreve — nem `data/hubs/prose-review-state.json`
      // (contrariava o próprio docstring do script) nem nada mais abaixo.
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

    saveProseReviewState(proseState);

    if (touched.length === 0) {
      // Sem mudança de dados: só reconcilia os achados de prosa (se houver) e sai.
      reconcileAlarms(proseFindings);
      process.stderr.write(`${LOG_PREFIX} nenhum hub com mudança de dados — nada a commitar.\n`);
      return;
    }

    if (!sessionId) {
      alarmFailure(
        "session-id-ausente",
        "Regen com mudança de dados exige --session-id pro merge lock (#8906, nota do editor) — abortando antes do commit.",
        proseFindings,
      );
      process.exitCode = 1;
      return;
    }

    const touchedSlugs = touched.map((h) => h.slug);
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
      run("git", ["add", ...HUBS_GIT_ADD_PATHS], workRoot);
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
    removeWorktree(workRoot, branch);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro não tratado: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
