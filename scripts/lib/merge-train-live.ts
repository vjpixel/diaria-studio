/**
 * merge-train-live.ts (#6300)
 *
 * ORQUESTRAÇÃO VIVA do trem de merge — a metade que `scripts/lib/merge-train.ts`
 * deixa de fora de propósito (lá só a lógica pura de composição de lote e
 * bissecção). Aqui: buscar metadados reais de cada PR, montar uma branch
 * de integração (merge em cadeia dos K PRs do lote sobre `master`), abrir
 * um PR-trem descartável só pra disparar **1** run de CI sobre a
 * combinação, fazer polling desse run, e — verde — mergear sob merge lock
 * com **1** commit squash fechando todas as issues do lote (decisão do
 * editor, 26/08/2026, ver `merge-train.ts`).
 *
 * DESIGN — injeção de runner (`TrainRunner`), não `spawnSync` direto nas
 * funções: cada função aqui é testável com um runner FAKE que devolve
 * respostas roteirizadas, sem tocar `git`/`gh`/rede de verdade. É o que
 * fecha a lacuna que o fleet review da PR #6361 apontou pro script irmão
 * `plan-merge-train.ts` (CLI-level exit-code/decisão só testável via
 * subprocess real) — aqui a ORQUESTRAÇÃO em si (não só validação de
 * argumento) também precisa de teste, e subprocess real faria CADA teste
 * abrir PR/rodar CI de verdade contra o GitHub. `test/merge-train-live.test.ts`
 * cobre a máquina de estados (bisecção em cascata, degradação pro
 * caminho de 1-a-1, timeout, conflito de merge) com o runner fake.
 *
 * `--session-id` explícito em toda chamada a `session-registry.ts`
 * (merge-lock-acquire/release): diferente de uma chamada Bash direta desta
 * SESSÃO (onde `.claude/hooks/inject-session-id.mjs` injeta automaticamente
 * o session_id no PreToolUse), uma chamada `exec()` DENTRO deste módulo é
 * um processo filho comum — o hook não intercepta isso. `runMergeTrain`
 * recebe `sessionId` como parâmetro obrigatório e propaga pra cada chamada
 * de `session-registry.ts` internamente.
 *
 * ISOLAMENTO EM WORKTREE (achado do fleet review, PR #6361 — 2ª rodada).
 * Montar a branch de integração, abrir o PR-trem e esperar o run de CI
 * (até 30 min por padrão) tocando o CHECKOUT PRINCIPAL compartilhado
 * violaria o próprio invariante do merge lock — o lock cobre só
 * `gh pr merge` + `git pull` (segundos, TTL de 2 min — ver
 * `session-registry.ts`), nunca uma janela de minutos sem lock nenhum.
 * `buildIntegrationBranch` monta a branch de integração num
 * `git worktree` ISOLADO (não o checkout principal) — o checkout
 * principal só é tocado no instante curto do merge de verdade
 * (`mergeTrainBatch`/`mergeSoloPr`, sob o lock), a mesma janela que
 * qualquer merge de PR único já usa hoje. Efeito colateral bom: como cada
 * lote ganha um worktree PRÓPRIO e descartável, uma falha de recuperação
 * dentro dele (ex: `git merge --abort` que também falha) nunca envenena o
 * lote seguinte — o pior caso é um diretório temp órfão, não um checkout
 * principal quebrado.
 *
 * REVALIDAÇÃO DE GATE 2 imediatamente antes de mergear (achado do fleet
 * review): `isGateOneGreen` (`merge-train-discovery.ts`) só filtra
 * candidatos na DESCOBERTA — entre a descoberta e o merge de verdade
 * (que pode levar minutos, com o CI do PR-trem no meio), o estado de
 * qualquer PR original pode mudar (novo commit, nova thread de review).
 * `revalidateGate2` reconfirma as 2 condições do Gate 2 por PR, bem antes
 * do merge — a condição 2 (threads) usa o mesmo `checkReviewThreads` do
 * caminho serial (#11269).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorktreeRemoval } from "./worktree-remove.ts"; // #8209
import {
  parseClosesIssues,
  parseRefsIssues,
  bisectBatch,
  buildTrainPrTitle,
  buildTrainPrBody,
  buildTrainMergeCommitTitle,
  buildTrainMergeCommitBody,
  buildSoloSquashSubject,
  buildSoloSquashBody,
  type SoloSquashCommit,
  computeTrainGateLabels,
  type TrainBatch,
  type TrainPrInfo,
} from "./merge-train.ts";
import { evaluatePrChecksGate } from "./pr-checks-gate.ts";
import { classifyFfRefusal, discardCollisionsIdenticalToUpstream } from "./git-sync.ts"; // #12223
import type { GitSpawnFn } from "./spawn-types.ts";
import { extractRemovalDeclaration } from "./pr-removal-declaration.ts"; // #10848
import { extractPendingDataWrites, type PendingDataWrite } from "./pending-data-writes.ts"; // #12026
import { evaluatePrRetido, type PrRetidoResult } from "./pr-retido-para-editor.ts";
import { checkReviewThreads, EXIT_OK as THREADS_EXIT_OK } from "../resolve-review-threads.ts"; // #11269

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface TrainRunner {
  /** `cwd` opcional SOBRESCREVE o cwd default do runner só nesta chamada —
   * usado pra rodar `git` dentro do worktree isolado da branch de
   * integração sem precisar de um runner por worktree. Chamadas de `gh`
   * (que resolvem o repo pela URL remota, não pelo cwd de forma sensível a
   * isolamento) e de `npx tsx session-registry.ts` seguem usando o cwd
   * default (checkout principal). */
  exec(cmd: string, args: string[], cwd?: string): ExecResult;
  sleep(ms: number): Promise<void>;
  /** ms desde uma origem arbitrária monotônica — só usado pra medir elapsed, nunca gravado. */
  now(): number;
  /** Diretório temporário único pra um novo worktree (não cria nada — só
   * reserva o path; `git worktree add` é quem cria de fato). */
  mkTempDir(prefix: string): string;
  /** Log de aviso não-fatal (achado a próxima do fleet review — cleanup
   * best-effort que falha precisa aparecer em algum lugar, não só ser
   * engolido). O runner REAL escreve em stderr; o runner fake de teste
   * acumula pra asserção. */
  warn(message: string): void;
}

/** Runner real — `spawnSync`, timeout de 60s por chamada individual (não é
 * o timeout do POLLING de CI, que é orquestrado por `pollTrainCi` chamando
 * este `exec` várias vezes). */
export function createRealTrainRunner(
  defaultCwd: string,
  platform: NodeJS.Platform = process.platform,
  spawn: typeof spawnSync = spawnSync,
): TrainRunner {
  return {
    exec(cmd, args, cwd) {
      // npx.cmd exige shell no Windows; Node + tsx preserva argv (#7053).
      const directTsx = platform === "win32" && cmd === "npx" && args[0] === "tsx";
      const executable = directTsx ? process.execPath : cmd;
      const spawnArgs = directTsx ? ["--import", "tsx", ...args.slice(1)] : args;
      const r = spawn(executable, spawnArgs, { cwd: cwd ?? defaultCwd, encoding: "utf8", timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
      if (r.error) return { ok: false, stdout: "", stderr: (r.error as NodeJS.ErrnoException).code === "ENOENT"
        ? `executável não encontrado: ${executable} (cwd: ${cwd ?? defaultCwd}): ${r.error.message}`
        : r.error.message };
      return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    mkTempDir: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
    warn: (message) => console.error(`run-merge-train: AVISO — ${message}`),
  };
}

/** Repo do trem de merge (#10618, fatia 4, review 2): o trem é SÓ-studio. */
export const TRAIN_REPO = "vjpixel/diaria-studio";
/** Branch base dos PRs do studio — PR do diaria-design mira `main`. */
export const TRAIN_BASE_BRANCH = "master";

export type StudioTrainPrCheck =
  | { verdict: "studio" }
  /** Confirmado que NÃO é um PR do studio mirando master (outro repo, outra base, fork). */
  | { verdict: "foreign"; reason: string }
  /** #10901: PR do studio que não está mais aberto (fechado/mergeado entre a
   * composição e o trem). Nada a mergear — pula, nunca recusa o trem. */
  | { verdict: "closed"; reason: string }
  /** Não deu pra ler (gh falhou/JSON ruim) — fail-closed, mas é falha operacional. */
  | { verdict: "unreadable"; reason: string };

/**
 * Recusa mecânica de PR de outro repo no trem (#10618, fatia 4, review 2).
 * `run-merge-train.ts` consulta `gh pr view N` SEM `-R` — o número de um PR
 * do diaria-design passado por engano em `--prs` resolveria o PR #N do
 * studio e o trem o mergearia. Confere, pelo próprio GitHub, que o PR é do
 * studio (`url` em `github.com/vjpixel/diaria-studio/pull/N`), está ABERTO,
 * mira `master` (PR do design mira `main`) e não vem de fork. Qualquer
 * divergência = `foreign`; leitura impossível = `unreadable` (nunca `studio`).
 */
export function checkStudioTrainPr(runner: TrainRunner, prNumber: number): StudioTrainPrCheck {
  const res = runner.exec("gh", ["pr", "view", String(prNumber), "--json", "number,state,baseRefName,url,isCrossRepository"]);
  if (!res.ok) return { verdict: "unreadable", reason: `gh pr view falhou pro PR #${prNumber}: ${res.stderr.trim() || "sem saída"}` };
  let p: { state?: unknown; baseRefName?: unknown; url?: unknown; isCrossRepository?: unknown };
  try {
    p = JSON.parse(res.stdout) as typeof p;
  } catch (e) {
    return { verdict: "unreadable", reason: `PR #${prNumber}: JSON malformado de gh pr view (${(e as Error).message})` };
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    return { verdict: "unreadable", reason: `PR #${prNumber}: payload inesperado de gh pr view` };
  }
  const url = typeof p.url === "string" ? p.url : "";
  const expectedUrl = new RegExp(`^https://github\\.com/${TRAIN_REPO}/pull/${prNumber}$`, "i");
  if (!expectedUrl.test(url)) {
    return { verdict: "foreign", reason: `PR #${prNumber} não é do ${TRAIN_REPO} (url: ${url || "ausente"}) — o trem é só-studio` };
  }
  if (p.baseRefName !== TRAIN_BASE_BRANCH) {
    return { verdict: "foreign", reason: `studio PR #${prNumber} mira "${String(p.baseRefName)}", não ${TRAIN_BASE_BRANCH}` };
  }
  if (p.isCrossRepository === true) {
    return { verdict: "foreign", reason: `PR #${prNumber} vem de fork (isCrossRepository) — fora do trem` };
  }
  if (p.state !== "OPEN") {
    // #10901: a mensagem antiga ("número de PR de outro repo?") enganava no caso
    // comum — PR fechado/mergeado entre a composição e o trem.
    return {
      verdict: "closed",
      reason: `studio PR #${prNumber} não está aberto (state: ${String(p.state)}) — fechado ou mergeado depois de entrar na lista; nada a mergear`,
    };
  }
  return { verdict: "studio" };
}

/** Resultado da triagem só-studio de todos os PRs candidatos (#10901). */
export interface TrainPrScreen {
  /** PRs abertos do studio mirando master — seguem pro trem. */
  admitted: number[];
  /** Pulados sem falhar o trem (PR fechado; ou, em `--open`, PR de fora). */
  skipped: string[];
  /** Recusam o trem inteiro (exit 2): PR de fora passado EXPLICITAMENTE em `--prs`. */
  refused: string[];
  /** Leitura impossível — falha operacional (exit 1), fail-closed. */
  unreadable: string[];
}

/**
 * Aplica `checkStudioTrainPr` a cada candidato (#10901). `discovered` = os PRs
 * vieram de `--open` (descoberta automática): aí um PR de fork ou com base
 * diferente de `master` é só filtrado — ninguém o pediu, e recusar o trem
 * inteiro por ele travaria todos os outros. Em `--prs` (lista explícita) o PR
 * de fora continua recusando o trem: é sinal de número de outro repo passado
 * por engano. PR fechado é pulado nos dois modos.
 */
export function screenTrainPrs(runner: TrainRunner, prNumbers: number[], discovered: boolean): TrainPrScreen {
  const out: TrainPrScreen = { admitted: [], skipped: [], refused: [], unreadable: [] };
  for (const pr of prNumbers) {
    const check = checkStudioTrainPr(runner, pr);
    if (check.verdict === "studio") out.admitted.push(pr);
    else if (check.verdict === "closed") out.skipped.push(check.reason);
    else if (check.verdict === "foreign") (discovered ? out.skipped : out.refused).push(check.reason);
    else out.unreadable.push(check.reason);
  }
  return out;
}

/** Busca metadados reais de um PR (`gh pr view`) e extrai as issues que
 * ele fecha do próprio corpo (`parseClosesIssues`, mesmo parser que
 * `buildTrainPrBody`/`buildTrainMergeCommitBody` consomem via `TrainPrInfo`). */
export function fetchTrainPrInfo(runner: TrainRunner, prNumber: number): TrainPrInfo {
  const res = runner.exec("gh", ["pr", "view", String(prNumber), "--json", "number,headRefName,title,body,labels,files,changedFiles,commits"]);
  if (!res.ok) throw new Error(`fetchTrainPrInfo: gh pr view falhou pro PR #${prNumber}: ${res.stderr}`);
  const parsed: unknown = JSON.parse(res.stdout);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`fetchTrainPrInfo: PR #${prNumber} — JSON inesperado de gh pr view`);
  }
  const p = parsed as { number: number; headRefName: string; title: string; body: string; labels?: unknown; files?: unknown; changedFiles?: unknown; commits?: unknown };
  return {
    pr: p.number,
    headRefName: p.headRefName,
    title: p.title,
    issueNumbers: parseClosesIssues(p.body ?? ""),
    refsIssueNumbers: parseRefsIssues(p.body ?? ""),
    removalDeclaration: extractRemovalDeclaration(p.body ?? ""),
    labels: parseLabelNames(p.labels),
    changedFiles: parseChangedFiles(p.files, p.changedFiles),
    commits: Array.isArray(p.commits) ? p.commits : [],
    pendingDataWrites: readPendingDataWrites(runner, prNumber, p.body ?? ""),
  };
}

/**
 * Seção `Escrita pendente em data/` da PR (#12026). Fail-soft: o parser é
 * texto puro, mas qualquer exceção vira aviso e lista vazia — coletar a
 * escrita nunca pode impedir o merge do lote.
 */
function readPendingDataWrites(runner: TrainRunner, prNumber: number, body: string): PendingDataWrite[] {
  try {
    return [...extractPendingDataWrites(body).writes];
  } catch (err) {
    runner.warn(`PR #${prNumber}: seção "Escrita pendente em data/" ilegível, ignorada (#12026): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** `labels` de `gh pr view --json labels` → nomes; shape inesperado = não lidas (#11019). */
function parseLabelNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = raw.map((l) => (typeof l === "object" && l !== null ? (l as { name?: unknown }).name : undefined));
  return names.every((n): n is string => typeof n === "string") ? names : undefined;
}

/**
 * `files` de `gh pr view --json files` → paths (#11019). O `gh` traz no máximo
 * 100 arquivos: com menos itens que `changedFiles` a lista é incompleta e
 * vira `null`, que `computeTrainGateLabels` trata como "precisa da label".
 */
function parseChangedFiles(raw: unknown, total: unknown): string[] | null | undefined {
  if (!Array.isArray(raw)) return undefined;
  const paths = raw.map((f) => (typeof f === "object" && f !== null ? (f as { path?: unknown }).path : undefined));
  if (!paths.every((x): x is string => typeof x === "string")) return null;
  if (typeof total !== "number" || paths.length < total) return null;
  return paths;
}

/**
 * Aplica ao PR-trem as labels de gate herdadas do lote (#11019,
 * `computeTrainGateLabels`). Via `gh-pr-safe-edit.ts --add-label` (REST +
 * releitura), nunca `gh pr edit --add-label`, que não aplica label (#10429).
 * Chamada logo depois do `gh pr create`: os workflows dos gates rodam também
 * em `labeled`, e a run nova cancela a do `opened` (o rollup descarta a
 * `CANCELLED` substituída, `pr-checks-gate.ts`). Falha não é fatal: o
 * PR-trem só reprova como reprovaria antes, e o aviso fica no log.
 */
export function applyTrainGateLabels(
  runner: TrainRunner,
  trainPrNumber: number,
  batch: TrainBatch,
  prInfos: readonly TrainPrInfo[],
): readonly string[] {
  const { labels } = computeTrainGateLabels(batch, prInfos);
  if (labels.length === 0) return [];
  const res = runner.exec("npx", ["tsx", "scripts/lib/gh-pr-safe-edit.ts", "--pr", String(trainPrNumber), "--add-label", labels.join(",")]);
  if (!res.ok) {
    runner.warn(`não consegui aplicar ${labels.join(", ")} ao PR-trem #${trainPrNumber} (#11019) — o gate pode reprovar o lote: ${res.stderr.trim() || res.stdout.trim() || "sem saída"}`);
    return [];
  }
  return labels;
}

/**
 * Sinal `retido-para-editor` (#10278/#10294) de um PR, lido ao vivo
 * (`gh pr view --json labels,body`). Falha de `gh`/JSON → `retido: null`
 * (fail-closed: os chamadores tratam como retido, nunca como livre).
 */
export function checkPrRetido(runner: TrainRunner, prNumber: number): PrRetidoResult {
  const res = runner.exec("gh", ["pr", "view", String(prNumber), "--json", "labels,body"]);
  if (!res.ok) return { retido: null, reason: `gh pr view (labels,body) falhou — fail-closed: ${res.stderr}` };
  let payload: unknown;
  try {
    payload = JSON.parse(res.stdout);
  } catch (e) {
    return { retido: null, reason: `JSON malformado de gh pr view (labels,body) — fail-closed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof payload !== "object" || payload === null) {
    return { retido: null, reason: "gh pr view (labels,body) devolveu JSON não-objeto — fail-closed" };
  }
  const p = payload as { labels?: unknown; body?: unknown };
  return evaluatePrRetido({ labels: p.labels, body: p.body });
}

export interface RetidoExclusion {
  pr: number;
  /** `true` = retida de fato; `null` = sinal ilegível (fail-closed). */
  retido: true | null;
  reason: string;
}

/**
 * Separa os candidatos do trem (#10294) em elegíveis e excluídos por
 * `retido-para-editor` ANTES de compor os lotes — uma PR retida nunca entra
 * num lote, e por isso nunca prende os demais (o lote é composto só com o
 * que sobra). Ordem dos elegíveis preservada.
 */
export function partitionRetidoCandidates(
  runner: TrainRunner,
  prNumbers: readonly number[],
): { eligible: number[]; excluded: RetidoExclusion[] } {
  const eligible: number[] = [];
  const excluded: RetidoExclusion[] = [];
  for (const pr of prNumbers) {
    const v = checkPrRetido(runner, pr);
    if (v.retido === false) eligible.push(pr);
    else excluded.push({ pr, retido: v.retido, reason: v.reason });
  }
  return { eligible, excluded };
}

export interface Gate2Result {
  ok: boolean;
  reason?: string;
  /** Presente quando a reprovação veio da condição 3 (`retido-para-editor`,
   * #10294) — o chamador tira só ESTE PR do lote em vez de travar o lote.
   * `true` = retido de fato; `null` = sinal ilegível no instante do merge
   * (fail-closed, #10299 — não é retenção deliberada, conta como falha). */
  retido?: true | null;
  /** #12734: presente quando a reprovação veio da condição 2 com thread(s)
   * de review não resolvida(s) que bloqueiam — os IDs das threads retidas.
   * Ausente quando a condição 2 falhou por erro de query/paginação (aí não
   * há lista confiável — ver `threadsUnreadable`). */
  blockingThreads?: string[];
  /** #12734 (review da PR #12740): `true` quando a condição 2 falhou por
   * ERRO de query/paginação das threads — não há lista confiável, então o
   * chamador rotula `threads-ilegiveis` (nem `threads-bloqueantes`, nem o
   * genérico `lock-blocked`). */
  threadsUnreadable?: true;
}

/**
 * Revalidação do Gate 2 (as 2 condições + a condição 3 `retido-para-editor`,
 * #10294) imediatamente antes de mergear —
 * chamada por `mergeTrainBatch` (por PR do lote) e `mergeSoloPr` (pro PR
 * único). A condição 2 usa `checkReviewThreads` (`resolve-review-threads.ts
 * --check`, #11269) — o mesmo gate do caminho serial: thread de revisor
 * externo (`viewerCanResolve: false`) não bloqueia; erro de query, payload
 * sem `data`/`pageInfo` e mais de 100 threads (`hasNextPage`) reprovam,
 * nunca contam como zero threads.
 */
export function revalidateGate2(runner: TrainRunner, prNumber: number, sessionId?: string): Gate2Result {
  const view = runner.exec("gh", ["pr", "view", String(prNumber), "--json", "statusCheckRollup"]);
  if (!view.ok) return { ok: false, reason: `gh pr view falhou: ${view.stderr}` };

  let rollup: unknown;
  try {
    const parsed: unknown = JSON.parse(view.stdout);
    rollup =
      typeof parsed === "object" && parsed !== null && "statusCheckRollup" in parsed
        ? (parsed as { statusCheckRollup: unknown }).statusCheckRollup
        : undefined;
  } catch (e) {
    return { ok: false, reason: `JSON malformado de gh pr view (statusCheckRollup): ${e instanceof Error ? e.message : String(e)}` };
  }
  const gate = evaluatePrChecksGate(rollup);
  if (gate.verdict !== "pass") {
    return { ok: false, reason: `condição 1 (CI) não está pass — veredito atual: ${gate.verdict}` };
  }

  // Condição 2 (#11269): o MESMO gate do caminho serial
  // (`resolve-review-threads.ts --check`), nunca uma query própria. A query
  // própria que havia aqui não lia `hasNextPage` e tratava resposta sem `data`
  // como zero threads — uma PR com >100 threads, ou um payload truncado,
  // passava no trem e seria barrada no caminho serial.
  const threads = checkReviewThreads(TRAIN_REPO, prNumber, (args) => {
    const r = runner.exec("gh", args);
    return { status: r.ok ? 0 : 1, stdout: r.stdout, stderr: r.stderr };
  });
  if (threads.exitCode !== THREADS_EXIT_OK) {
    if (threads.error) return { ok: false, reason: `condição 2 (threads) — ${threads.error}`, threadsUnreadable: true };
    return {
      ok: false,
      reason: `condição 2 (threads) — ${threads.blocking.length} thread(s) não resolvida(s) que bloqueiam: ${threads.blocking.join(", ")}`,
      blockingThreads: [...threads.blocking],
    };
  }

  // Condição 3 (#10278/#10294): PR retida para o editor. Relida aqui, no
  // instante do merge, porque a label pode ter sido aplicada por outra
  // trilha DEPOIS da descoberta (`partitionRetidoCandidates`). Ilegível →
  // fail-closed: o PR sai do lote e o resto segue, mas com `retido: null`
  // (#10299) — o chamador o reporta como falha, não como retenção.
  const retido = checkPrRetido(runner, prNumber);
  if (retido.retido !== false) {
    return { ok: false, retido: retido.retido, reason: `condição 3 (retido-para-editor) — ${retido.reason}` };
  }

  const claims = runner.exec("npx", ["tsx", "scripts/check-pr-session-claims.ts", "--pr", String(prNumber), "--session-id", sessionId ?? ""]);
  if (!claims.ok) return { ok: false, reason: `claims: ${claims.stderr || claims.stdout}` };
  return { ok: true };
}

export interface IntegrationBranchResult {
  ok: boolean;
  branchName: string;
  /** Caminho do worktree isolado — presente sempre que `git worktree add`
   * chegou a rodar (mesmo em falha depois disso), pra `cleanupIntegrationBranch`
   * sempre ter o que remover. */
  worktreePath: string;
  /** Presente só quando ok=false — o PR cujo merge conflitou. */
  conflictOnPr?: number;
  error?: string;
}

/**
 * Monta a branch de integração NUM WORKTREE ISOLADO (ver nota no
 * cabeçalho do arquivo) — parte de `origin/{baseBranch}` fresco e faz
 * `git merge --no-ff` de cada PR do lote EM SEQUÊNCIA (não `git rebase`
 * literal — decisão de implementação: como por construção nenhum PR do
 * lote colide em arquivo com outro, `git merge` aplica limpo sem risco de
 * reescrever commits/hashes que um rebase de verdade traria; atinge o
 * MESMO objetivo do critério de aceite — validar a COMBINAÇÃO dos K com 1
 * run de CI — com uma primitiva git mais simples e previsível). Push da
 * branch pro remoto ao final, pronta pra abrir o PR-trem.
 */
export function buildIntegrationBranch(
  runner: TrainRunner,
  batch: TrainBatch,
  prInfos: readonly TrainPrInfo[],
  opts: { baseBranch: string; branchName: string; mainCwd: string },
): IntegrationBranchResult {
  const byNumber = new Map(prInfos.map((p) => [p.pr, p]));
  const worktreePath = runner.mkTempDir("merge-train-");

  const fetchBase = runner.exec("git", ["fetch", "origin", opts.baseBranch], opts.mainCwd);
  if (!fetchBase.ok) {
    return { ok: false, branchName: opts.branchName, worktreePath, error: `git fetch base falhou: ${fetchBase.stderr}` };
  }

  const addWorktree = runner.exec(
    "git",
    ["worktree", "add", worktreePath, "-b", opts.branchName, `origin/${opts.baseBranch}`],
    opts.mainCwd,
  );
  if (!addWorktree.ok) {
    return { ok: false, branchName: opts.branchName, worktreePath, error: `git worktree add falhou: ${addWorktree.stderr}` };
  }

  for (const pr of batch.prs) {
    const info = byNumber.get(pr);
    if (!info) {
      return { ok: false, branchName: opts.branchName, worktreePath, conflictOnPr: pr, error: `PR #${pr} sem TrainPrInfo — não deveria acontecer` };
    }
    const fetchPr = runner.exec("git", ["fetch", "origin", info.headRefName], worktreePath);
    if (!fetchPr.ok) {
      return { ok: false, branchName: opts.branchName, worktreePath, conflictOnPr: pr, error: `git fetch da branch do PR #${pr} falhou: ${fetchPr.stderr}` };
    }
    const merge = runner.exec("git", ["merge", "--no-edit", "--no-ff", "FETCH_HEAD"], worktreePath);
    if (!merge.ok) {
      // Aborta o merge conflituoso — o worktree é DESCARTÁVEL (removido em
      // `cleanupIntegrationBranch` de qualquer jeito), então mesmo que o
      // --abort falhe, o pior caso é um diretório temp órfão — nunca um
      // checkout PRINCIPAL poluído (diferente da versão anterior desta
      // função, que fazia checkout -b no checkout compartilhado — achado
      // do fleet review, corrigido pelo isolamento em worktree).
      const abort = runner.exec("git", ["merge", "--abort"], worktreePath);
      if (!abort.ok) {
        runner.warn(`git merge --abort falhou no worktree ${worktreePath} (PR #${pr}) — worktree será descartado mesmo assim: ${abort.stderr}`);
      }
      return {
        ok: false,
        branchName: opts.branchName,
        worktreePath,
        conflictOnPr: pr,
        error: `merge do PR #${pr} conflitou: ${merge.stderr}`,
      };
    }
  }

  const push = runner.exec("git", ["push", "-u", "origin", opts.branchName], worktreePath);
  if (!push.ok) return { ok: false, branchName: opts.branchName, worktreePath, error: `git push falhou: ${push.stderr}` };

  return { ok: true, branchName: opts.branchName, worktreePath };
}

/** Abre o PR-trem descartável (`gh pr create`) e devolve o número. */
export function openTrainPr(
  runner: TrainRunner,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string,
): number {
  const res = runner.exec("gh", ["pr", "create", "--base", baseBranch, "--head", branchName, "--title", title, "--body", body]);
  if (!res.ok) throw new Error(`openTrainPr: gh pr create falhou: ${res.stderr}`);
  // gh pr create imprime a URL no stdout — o número é o último segmento.
  const match = res.stdout.trim().match(/\/(\d+)\s*$/);
  if (!match) throw new Error(`openTrainPr: não consegui extrair o número do PR da saída: ${res.stdout}`);
  return Number(match[1]);
}

export type TrainCiVerdict = "pass" | "fail" | "timeout";

/**
 * Polling da condição 1 do Gate 2 sobre o PR-trem — mesma lógica de
 * `scripts/check-pr-checks-gate.ts`/`evaluatePrChecksGate`, repetida até
 * `pass`/`fail` conclusivo ou estourar `timeoutMs`. Timeout vira `"fail"`
 * pro CHAMADOR (runMergeTrain trata os dois igual, bissecta) — mas o tipo
 * de retorno preserva a distinção pra quem quiser logar diferente ("CI
 * nunca terminou" ≠ "CI reprovou"), mesma convenção já usada nas skills
 * pra timeout de CI (`context/overnight-dispatch-rules.md`: "timeout de
 * CI = 30 min → tratar como CI vermelho").
 */
export async function pollTrainCi(
  runner: TrainRunner,
  trainPrNumber: number,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<TrainCiVerdict> {
  const start = runner.now();
  for (;;) {
    const res = runner.exec("gh", ["pr", "view", String(trainPrNumber), "--json", "statusCheckRollup"]);
    if (res.ok) {
      // Achado do fleet review (PR #6361): o `try` cobria SÓ `JSON.parse`
      // antes, mas envolvia também `evaluatePrChecksGate` — uma exceção
      // real ali (bug de código, shape inesperado) virava "pending" e
      // era retentada silenciosamente até o timeout, disfarçando um bug
      // de código como se fosse só "CI demorou". Agora o parse (o único
      // ponto que legitimamente pode falhar por dado malformado) é
      // isolado; uma exceção de `evaluatePrChecksGate` propaga de verdade.
      let rollup: unknown;
      let parseOk = true;
      try {
        const parsed: unknown = JSON.parse(res.stdout);
        rollup =
          typeof parsed === "object" && parsed !== null && "statusCheckRollup" in parsed
            ? (parsed as { statusCheckRollup: unknown }).statusCheckRollup
            : undefined;
      } catch {
        parseOk = false; // JSON malformado nesta rodada — trata como pending, tenta de novo.
      }
      if (parseOk) {
        const gate = evaluatePrChecksGate(rollup);
        if (gate.verdict === "pass") return "pass";
        if (gate.verdict === "fail") return "fail";
        // "pending" ou "error" (statusCheckRollup ainda sem checks registrados) — tenta de novo até o timeout.
      }
    }
    if (runner.now() - start >= opts.timeoutMs) return "timeout";
    await runner.sleep(opts.intervalMs);
  }
}

export interface MergeTrainBatchResult {
  ok: boolean;
  error?: string;
  /** `true` só quando a causa da falha foi o merge lock negado (outra
   * sessão mergeando agora) — `runMergeTrain` usa isto pra decidir retry
   * em vez de descarte, diferente de qualquer outra causa de falha. */
  lockDenied?: boolean;
  /** PR do lote reprovado na condição 3 (`retido-para-editor`, #10294) no
   * instante do merge — `runMergeTrain` o tira do lote e reprocessa o resto,
   * em vez de rotular o lote inteiro como `lock-blocked`. */
  retidoPr?: number;
  /** #10299: com `retidoPr`, `true` quando o sinal estava ILEGÍVEL (não
   * retido de fato) — vira status `retido-ilegivel`, que conta como falha. */
  retidoIlegivel?: boolean;
  /** #12734: PR do lote reprovado na condição 2 do Gate 2 por thread(s) de
   * review aberta(s) que bloqueiam — `runMergeTrain` rotula o outcome como
   * `threads-bloqueantes` (nunca `lock-blocked`, que manda investigar sessão
   * concorrente). */
  threadsBlockedPr?: number;
  /** IDs das threads retidas do `threadsBlockedPr`. */
  blockingThreads?: string[];
  /** PR do lote cuja condição 2 falhou por erro de leitura das threads —
   * `runMergeTrain` rotula o outcome como `threads-ilegiveis`. */
  threadsUnreadablePr?: number;
  /** #13461: com o merge lock em mãos, a base remota NÃO estava contida no
   * HEAD que ia ser mergeado — o CI verde desse HEAD é de uma base antiga e
   * não prova a combinação com o que entrou depois. Nada foi mergeado;
   * `runMergeTrain` revalida sobre a base atual (PR-trem) em vez de mergear. */
  staleBase?: { headSha: string; baseSha: string; behindBy: number };
  /** #13645: o merge solo achou a PR já MERGED (mergeada fora do trem) e
   * devolveu ok sem mergear nada. */
  alreadyMerged?: boolean;
}

const SHA40 = /^[0-9a-f]{40}$/;

/** HEAD atual (40 hex) de um PR — `gh pr view --json headRefOid` (#13461). */
export function readPrHeadSha(runner: TrainRunner, prNumber: number): { ok: true; sha: string } | { ok: false; reason: string } {
  const res = runner.exec("gh", ["pr", "view", String(prNumber), "--json", "headRefOid"]);
  if (!res.ok) return { ok: false, reason: `gh pr view --json headRefOid falhou pro PR #${prNumber}: ${res.stderr.trim() || "sem saída"}` };
  try {
    const sha = (JSON.parse(res.stdout) as { headRefOid?: unknown }).headRefOid;
    if (typeof sha === "string" && SHA40.test(sha)) return { ok: true, sha };
    return { ok: false, reason: `PR #${prNumber}: headRefOid ausente ou fora do formato de 40 hex (${JSON.stringify(sha)})` };
  } catch (e) {
    return { ok: false, reason: `PR #${prNumber}: JSON malformado de gh pr view (headRefOid): ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type BaseFreshness =
  /** O HEAD contém a ponta atual da base: o CI dele vale para a base de agora. */
  | { verdict: "fresh"; baseSha: string }
  /** A base tem `behindBy` commit(s) fora do HEAD: o CI do HEAD é de base antiga. */
  | { verdict: "stale"; baseSha: string; behindBy: number }
  /** Não deu para saber (gh falhou, payload inesperado) — nunca tratado como `fresh`. */
  | { verdict: "unknown"; reason: string };

/**
 * A ponta ATUAL da base remota está contida em `headSha`? (#13461)
 *
 * Uma chamada à API de comparação do GitHub (`compare/{base}...{head}`): o
 * `{base}` é resolvido pelo GitHub no instante da consulta, então ler isto
 * com o merge lock em mãos é o "reler o SHA da base com o lock" da regra
 * #10927 do `/diaria-overnight`. `behind_by: 0` (status `ahead`/`identical`)
 * = o HEAD já tem tudo da base. Roda no GitHub, sem `git fetch` no checkout
 * principal compartilhado.
 */
export function checkHeadContainsBase(runner: TrainRunner, headSha: string, baseBranch: string = TRAIN_BASE_BRANCH): BaseFreshness {
  const res = runner.exec("gh", [
    "api",
    `repos/${TRAIN_REPO}/compare/${baseBranch}...${headSha}`,
    "--jq",
    "{status: .status, behind_by: .behind_by, base_sha: .base_commit.sha}",
  ]);
  if (!res.ok) return { verdict: "unknown", reason: `gh api compare ${baseBranch}...${headSha.slice(0, 12)} falhou: ${res.stderr.trim() || "sem saída"}` };
  let p: { status?: unknown; behind_by?: unknown; base_sha?: unknown };
  try {
    p = JSON.parse(res.stdout) as typeof p;
  } catch (e) {
    return { verdict: "unknown", reason: `JSON malformado de gh api compare: ${e instanceof Error ? e.message : String(e)}` };
  }
  const baseSha = typeof p?.base_sha === "string" && SHA40.test(p.base_sha) ? p.base_sha : null;
  const behindBy = typeof p?.behind_by === "number" && Number.isInteger(p.behind_by) && p.behind_by >= 0 ? p.behind_by : null;
  if (!baseSha || behindBy === null || typeof p.status !== "string") {
    return { verdict: "unknown", reason: `gh api compare devolveu payload inesperado: ${res.stdout.trim().slice(0, 200)}` };
  }
  if (behindBy > 0) return { verdict: "stale", baseSha, behindBy };
  if (p.status === "ahead" || p.status === "identical") return { verdict: "fresh", baseSha };
  return { verdict: "unknown", reason: `gh api compare: status "${p.status}" com behind_by 0` };
}

/** Campos de `MergeTrainBatchResult` derivados das condições 2 e 3 do Gate 2. */
function gate2FailureFields(
  gate: Gate2Result,
  pr: number,
): Pick<MergeTrainBatchResult, "retidoPr" | "retidoIlegivel" | "threadsBlockedPr" | "blockingThreads" | "threadsUnreadablePr"> {
  if (gate.blockingThreads !== undefined) return { threadsBlockedPr: pr, blockingThreads: gate.blockingThreads };
  if (gate.threadsUnreadable) return { threadsUnreadablePr: pr };
  if (gate.retido === undefined) return {};
  return gate.retido === null ? { retidoPr: pr, retidoIlegivel: true } : { retidoPr: pr };
}

/**
 * Verifica o estado REAL do PR via `gh pr view --json state,mergedAt`
 * (#573 — nunca confiar só no exit code de `gh pr merge`: o merge pode ter
 * tido sucesso no remoto com uma falha puramente local/transitória do
 * comando). Usado depois de QUALQUER tentativa de `gh pr merge`, sucesso
 * ou falha reportada — se o estado real diz `MERGED`, o merge aconteceu,
 * ponto final, independente do que o exit code do comando alegou.
 */
export function confirmMerged(runner: TrainRunner, prNumber: number): boolean {
  const res = runner.exec("gh", ["pr", "view", String(prNumber), "--json", "state,mergedAt"]);
  if (!res.ok) return false; // não deu pra confirmar — trata como não-mergeado, nunca assume sucesso sem prova
  try {
    const parsed = JSON.parse(res.stdout) as { state?: string; mergedAt?: string | null };
    return parsed.state === "MERGED" && !!parsed.mergedAt;
  } catch {
    return false;
  }
}

/**
 * Atualiza o checkout principal depois de um merge confirmado (#11615).
 *
 * Antes era um `git pull` cru: com o checkout principal numa branch de outra
 * sessão sem upstream (visto no overnight 261029, `continuo/fix-11542-…`), o
 * git falhava com "There is no tracking information for the current branch"
 * e o trem transcrevia o erro inteiro. Agora:
 *   1. `git fetch origin master` sempre (seguro em qualquer branch — só
 *      atualiza `origin/master`, que é o que a coordenadora seguinte lê);
 *   2. só faz `git pull --ff-only origin master` se o checkout está em master;
 *   3. fora de master, devolve uma linha curta de aviso, sem tocar a branch
 *      alheia;
 *   4. pull recusado por cópia local idêntica ao que o merge trouxe (snapshot
 *      de audiência, #12223): descarta essas cópias e repete o pull uma vez.
 *
 * Nunca bloqueia: o merge no GitHub já é fato consumado. Devolve `null`
 * quando tudo foi atualizado, ou o aviso (uma linha) a reportar.
 */
export function syncLocalCheckoutAfterMerge(runner: TrainRunner, baseBranch: string = TRAIN_BASE_BRANCH): string | null {
  const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0] ?? "";
  const fetch = runner.exec("git", ["fetch", "origin", baseBranch]);
  const fetchNote = fetch.ok ? "" : ` (git fetch origin ${baseBranch} também falhou: ${firstLine(fetch.stderr)})`;
  const head = runner.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = head.ok ? head.stdout.trim() : "";
  if (!head.ok || !branch) {
    return `branch do checkout local ilegível, atualização local pulada${fetchNote}`;
  }
  if (branch !== baseBranch) {
    return `checkout local em ${branch}, não em ${baseBranch}: atualização local pulada${fetch.ok ? ` (origin/${baseBranch} atualizado)` : fetchNote}`;
  }
  const pull = runner.exec("git", ["pull", "--ff-only", "origin", baseBranch]);
  if (pull.ok) return null;
  const retried = retryPullAfterDiscardingIdenticalCopies(runner, baseBranch, pull.stderr);
  if (retried.ok) return null;
  return `git pull local falhou: ${firstLine(retried.stderr)}${retried.note}`;
}

/**
 * #12223: o `git pull --ff-only` do checkout principal recusa quando há cópia
 * local (modificada ou untracked) de um arquivo que o merge acabou de trazer,
 * mesmo com o conteúdo IDÊNTICO. Caso real: o snapshot de audiência do Stage 0
 * (passo 0i) fica no checkout, porque a edição do dia lê
 * `context/audience-profile.md` nas Etapas 1-2, e vai ao master pela PR
 * rolante `chore/audience-snapshot-*` (`commit-audience-snapshot.ts`).
 * Mergeada a PR, `context/audience-profile.md` modificado e
 * `docs/audience-history/*.md` untracked colidem com o master e o checkout
 * fica atrás até a próxima edição.
 *
 * Mesma saída do `sync-code.ts` (#11562): descartar as cópias idênticas a
 * origin/master (`discardCollisionsIdenticalToUpstream`, tudo-ou-nada, sem
 * perda: o pull escreveria os mesmos bytes) e repetir o pull uma vez. Só para
 * a base `master` (o helper compara com `origin/master`). Qualquer outra
 * recusa, ou colisão com conteúdo diferente, devolve a recusa original.
 */
function retryPullAfterDiscardingIdenticalCopies(
  runner: TrainRunner,
  baseBranch: string,
  pullStderr: string,
): { ok: boolean; stderr: string; note: string } {
  const original = { ok: false, stderr: pullStderr, note: "" };
  if (baseBranch !== "master") return original;
  const refusal = classifyFfRefusal(pullStderr);
  if (refusal.kind !== "local_changes_collide" && refusal.kind !== "untracked_collide") return original;
  const status = runner.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) return original;
  const spawn: GitSpawnFn = (cmd, args) => {
    const r = runner.exec(cmd, args);
    return { status: r.ok ? 0 : 1, stdout: r.stdout, stderr: r.stderr };
  };
  const { discarded } = discardCollisionsIdenticalToUpstream(spawn, refusal, status.stdout);
  if (discarded.length === 0) return original;
  const retry = runner.exec("git", ["pull", "--ff-only", "origin", baseBranch]);
  if (retry.ok) return { ok: true, stderr: "", note: "" };
  return {
    ok: false,
    stderr: retry.stderr,
    note: ` (depois de descartar ${discarded.length} cópia(s) idêntica(s) a origin/master, #12223)`,
  };
}

/**
 * Merge de verdade: revalida o Gate 2 de CADA PR original do lote
 * (`revalidateGate2` — estado pode ter mudado desde a descoberta), adquire
 * o merge lock cross-sessão (`session-registry.ts merge-lock-acquire`),
 * squash-merge do PR-trem com 1 commit fechando todas as issues do lote,
 * confirma o merge via estado real (`confirmMerged`, #573), atualiza o
 * checkout local (`syncLocalCheckoutAfterMerge`, #11615) (janela protegida do lock — só isso, ver docstring de
 * `merge-lock-acquire` em `session-registry.ts`), libera o lock, e fecha
 * cada PR ORIGINAL do lote com um comentário apontando pro commit squash
 * (GitHub não teria como auto-fechá-los sozinho — o código deles chegou
 * em master por uma branch DIFERENTE, a de integração, não a deles).
 *
 * `lockDenied` não é erro fatal por si — degrada pro chamador decidir
 * retry (ver `runMergeTrain`), nunca insiste sozinho aqui dentro.
 */
export function mergeTrainBatch(
  runner: TrainRunner,
  trainPrNumber: number,
  batch: TrainBatch,
  prInfos: readonly TrainPrInfo[],
  opts: { sessionId: string; kind: string; commitTitle: string; commitBody: string; baseBranch?: string },
): MergeTrainBatchResult {
  // #13388: PR mergeada fora do trem entre a descoberta e o merge é terminal
  // ok — fora da revalidação do Gate 2 e do fechamento (já está MERGED).
  const pendingPrs = batch.prs.filter((pr) => !confirmMerged(runner, pr));
  for (const pr of pendingPrs) {
    const gate = revalidateGate2(runner, pr, opts.sessionId);
    if (!gate.ok) {
      return {
        ok: false,
        error: `revalidação de Gate 2 falhou pro PR #${pr}: ${gate.reason}`,
        ...gate2FailureFields(gate, pr),
      };
    }
  }

  // #13461: o CI do PR-trem vale para a base em que a integração foi montada.
  // O HEAD lido aqui é o que vai ao `--match-head-commit`, e sob o lock a
  // base é relida contra ele (outra sessão pode ter mergeado durante o CI).
  const trainHead = readPrHeadSha(runner, trainPrNumber);
  if (!trainHead.ok) return { ok: false, error: `HEAD do PR-trem #${trainPrNumber} ilegível, sem merge (#13461): ${trainHead.reason}` };

  const acquire = runner.exec("npx", [
    "tsx",
    "scripts/lib/session-registry.ts",
    "merge-lock-acquire",
    "--kind",
    opts.kind,
    "--session-id",
    opts.sessionId,
  ]);
  if (!acquire.ok) {
    // Achado do fleet review: não presumir a causa — status != 0 aqui pode
    // ser "lock genuinamente detido por outra sessão" OU um erro interno
    // do script (crash, args ruins, I/O). Só a 1ª é `lockDenied`.
    const denied = /denied/i.test(acquire.stdout) || /denied/i.test(acquire.stderr);
    return {
      ok: false,
      lockDenied: denied,
      error: `merge-lock-acquire falhou (${denied ? "negado — outra sessão mergeando agora" : "causa não identificada, ver stderr"}): ${acquire.stderr || acquire.stdout}`,
    };
  }

  let mergeOk: boolean;
  let syncWarning: string | undefined;
  try {
    const fresh = checkHeadContainsBase(runner, trainHead.sha, opts.baseBranch ?? TRAIN_BASE_BRANCH);
    if (fresh.verdict === "stale") {
      return {
        ok: false,
        staleBase: { headSha: trainHead.sha, baseSha: fresh.baseSha, behindBy: fresh.behindBy },
        error: `base andou depois do CI do PR-trem #${trainPrNumber}: ${fresh.behindBy} commit(s) da base (${fresh.baseSha.slice(0, 12)}) fora do HEAD ${trainHead.sha.slice(0, 12)} (#13461)`,
      };
    }
    if (fresh.verdict === "unknown") {
      return { ok: false, error: `base atual não verificável sob o lock, sem merge do PR-trem #${trainPrNumber} (#13461): ${fresh.reason}` };
    }
    const merge = runner.exec("gh", [
      "pr",
      "merge",
      String(trainPrNumber),
      "--squash",
      "--match-head-commit",
      trainHead.sha,
      "--subject",
      opts.commitTitle,
      "--body",
      opts.commitBody,
    ]);
    mergeOk = merge.ok || confirmMerged(runner, trainPrNumber);
    if (!mergeOk) {
      return { ok: false, error: `gh pr merge --squash falhou (confirmado via gh pr view --json state,mergedAt): ${merge.stderr}` };
    }

    const syncNote = syncLocalCheckoutAfterMerge(runner);
    if (syncNote) {
      // O merge JÁ aconteceu no remoto (confirmado acima) — não é um
      // "ok: false" no sentido de "nada mudou"; é um estado local
      // defasado. Reporta, mas trata como sucesso pro fluxo de fechar as
      // PRs originais (o commit squash já existe no GitHub, é o que os
      // comentários de fechamento referenciam — não depende do checkout
      // local estar sincronizado).
      syncWarning = `merge OK (confirmado); ${syncNote} (não bloqueante)`;
    }
  } finally {
    runner.exec("npx", ["tsx", "scripts/lib/session-registry.ts", "merge-lock-release", "--kind", opts.kind, "--session-id", opts.sessionId]);
  }

  // Fechar as PRs ORIGINAIS do lote — o código delas já está em master via
  // squash do PR-trem, mas o GitHub não sabe disso sozinho (branches
  // diferentes). Best-effort por PR: uma falha aqui não desfaz o merge que
  // já aconteceu, só fica sem o comentário/close — reportado, não fatal.
  const closeFailures: string[] = [];
  for (const pr of pendingPrs) {
    const comment = runner.exec("gh", [
      "pr",
      "comment",
      String(pr),
      "--body",
      `Mergeado via trem de merge (#6300) — PR-trem #${trainPrNumber}, commit squash \`${opts.commitTitle}\`.`,
    ]);
    if (!comment.ok) closeFailures.push(`comentário no PR #${pr} falhou: ${comment.stderr}`);
    const close = runner.exec("gh", ["pr", "close", String(pr)]);
    if (!close.ok) closeFailures.push(`fechar PR #${pr} falhou: ${close.stderr}`);
  }

  const warnings = [...(syncWarning ? [syncWarning] : []), ...closeFailures];
  return warnings.length > 0 ? { ok: true, error: warnings.join("; ") } : { ok: true };
}

export interface CleanupResult {
  ok: boolean;
  error?: string;
}

/**
 * Remove o worktree de integração (força — a branch pode estar num merge
 * abortado, isso é esperado) e a branch remota/local — chamado depois de
 * mergear OU depois de descartar por vermelho/bisecção/conflito. Como
 * `buildIntegrationBranch` agora trabalha num worktree ISOLADO (não o
 * checkout principal), uma falha aqui nunca poluiu nada além desse
 * diretório descartável — best-effort em cada passo, logado via
 * `runner.warn` (não silenciosamente descartado, achado do fleet review),
 * mas nunca fatal pro run.
 */
export function cleanupIntegrationBranch(runner: TrainRunner, branchName: string, worktreePath: string, mainCwd: string): CleanupResult {
  const removeWorktree = runner.exec("git", ["worktree", "remove", "--force", worktreePath], mainCwd);
  if (!removeWorktree.ok) {
    runner.warn(`git worktree remove --force falhou pra ${worktreePath} — diretório temp pode ficar órfão: ${removeWorktree.stderr}`);
  }

  // #8209: git pode reportar sucesso e mesmo assim `worktreePath` sobreviver
  // (junction/symlink dentro dele) — resolveWorktreeRemoval faz a limpeza
  // segura de fallback só nesse caso (nunca quando o git em si falhou, ver
  // docstring do helper), mesmo mecanismo compartilhado por
  // cleanup-merged-worktrees.ts e branch-cleanup.ts. Só toca o filesystem —
  // não passa pelo TrainRunner injetado, então nunca precisa de mock de
  // `exec` pra ser testado.
  const worktreeResolved = resolveWorktreeRemoval(
    removeWorktree.ok ? { ok: true } : { ok: false, error: removeWorktree.stderr },
    worktreePath,
  );
  if (removeWorktree.ok && !worktreeResolved.ok) {
    runner.warn(`limpeza segura pós-remove (#8209) falhou pra ${worktreePath}: ${worktreeResolved.error}`);
  }

  runner.exec("git", ["push", "origin", "--delete", branchName], mainCwd); // best-effort — branch pode nunca ter sido pushada
  const deleteLocal = runner.exec("git", ["branch", "-D", branchName], mainCwd);
  if (!deleteLocal.ok && removeWorktree.ok) {
    // Só reporta se o worktree FOI removido (senão a falha de branch -D é
    // esperada — git recusa deletar branch ainda checked out em worktree).
    runner.warn(`git branch -D ${branchName} falhou após remover o worktree: ${deleteLocal.stderr}`);
  }
  return worktreeResolved.ok ? { ok: true } : { ok: false, error: `worktree remove falhou: ${worktreeResolved.error}` };
}

/** #13645: resultado terminal ok do merge solo de uma PR que já estava
 * MERGED (mergeada fora do trem). Nada é mergeado nem sincronizado; o
 * `error` só explica o `detail` do outcome. */
function alreadyMergedResult(prNumber: number): MergeTrainBatchResult {
  return { ok: true, alreadyMerged: true, error: `PR #${prNumber} já estava mergeada fora do trem; nada a mergear (#13645)` };
}

export interface MergeSoloOptions {
  sessionId: string;
  kind: string;
  baseBranch?: string; // default "master"
}

/** Piso da bissecção = caminho de HOJE, sem trem: revalida o Gate 2 do PR
 * (mesma revalidação que `mergeTrainBatch` faz por PR do lote) e mergeia
 * direto sob o mesmo merge lock, confirmando via estado real (#573).
 * #11190: usa título e body atuais da PR como mensagem explícita do squash.
 * Sem isso, o GitHub pode herdar Closes de um commit mesmo após o body
 * ter sido alterado para REFS (escopo parcial).
 *
 * Só confia no CI do PR quando o HEAD dele já contém a base ATUAL (#13461):
 * com o lock em mãos, `checkHeadContainsBase` relê a ponta da base contra o
 * HEAD validado. Base fora do HEAD (outra PR entrou depois do último push
 * desta) devolve `staleBase` sem mergear, e `runMergeTrain` revalida o PR
 * pelo caminho do lote (PR-trem de 1 sobre `origin/{base}` fresco), como faz
 * com o PR que esteve num lote vermelho (#10997). Foi o merge solo da #13456
 * com o CI de antes da #13458 que deixou o `tsc` do master vermelho. O merge
 * leva `--match-head-commit` com o HEAD validado: push concorrente na branch
 * recusa o merge. */
export function mergeSoloPr(runner: TrainRunner, prNumber: number, opts: MergeSoloOptions): MergeTrainBatchResult {
  // #13645: PR mergeada fora do trem (sessão interativa, entre a descoberta e
  // aqui) é terminal ok, como no lote (#13388). Sem isto, o
  // `checkHeadContainsBase` sob o lock lia o HEAD dela atrás da base (o
  // commit de squash não está no HEAD) e devolvia `staleBase`: CI de PR-trem
  // desperdiçado, ou `solo-failed` se a branch já tinha sido apagada.
  if (confirmMerged(runner, prNumber)) return alreadyMergedResult(prNumber);
  const gate = revalidateGate2(runner, prNumber, opts.sessionId);
  if (!gate.ok) {
    return { ok: false, error: `revalidação de Gate 2 falhou: ${gate.reason}`, ...gate2FailureFields(gate, prNumber) };
  }
  const head = readPrHeadSha(runner, prNumber);
  if (!head.ok) return { ok: false, error: `HEAD da PR #${prNumber} ilegível, base atual não verificável, sem merge (#13461): ${head.reason}` };

  const acquire = runner.exec("npx", [
    "tsx",
    "scripts/lib/session-registry.ts",
    "merge-lock-acquire",
    "--kind",
    opts.kind,
    "--session-id",
    opts.sessionId,
  ]);
  if (!acquire.ok) {
    const denied = /denied/i.test(acquire.stdout) || /denied/i.test(acquire.stderr);
    return {
      ok: false,
      lockDenied: denied,
      error: `merge-lock-acquire falhou (${denied ? "negado — outra sessão mergeando agora" : "causa não identificada, ver stderr"}): ${acquire.stderr || acquire.stdout}`,
    };
  }
  try {
    // #13645: de novo sob o lock — o merge por fora pode ter caído entre a
    // checagem do início e o acquire.
    if (confirmMerged(runner, prNumber)) return alreadyMergedResult(prNumber);
    const fresh = checkHeadContainsBase(runner, head.sha, opts.baseBranch ?? TRAIN_BASE_BRANCH);
    if (fresh.verdict === "stale") {
      return {
        ok: false,
        staleBase: { headSha: head.sha, baseSha: fresh.baseSha, behindBy: fresh.behindBy },
        error: `PR #${prNumber} atrás da base atual: ${fresh.behindBy} commit(s) da base (${fresh.baseSha.slice(0, 12)}) fora do HEAD ${head.sha.slice(0, 12)}; o CI verde dela é de base antiga (#13461)`,
      };
    }
    if (fresh.verdict === "unknown") {
      return { ok: false, error: `base atual não verificável sob o lock, sem merge da PR #${prNumber} (#13461): ${fresh.reason}` };
    }
    const message = runner.exec("gh", ["pr", "view", String(prNumber), "--json", "title,body,commits"]);
    if (!message.ok) return { ok: false, error: `mensagem da PR #${prNumber} ilegível: ${message.stderr}` };
    let title: string;
    let body: string;
    let commits: SoloSquashCommit[];
    try {
      const data = JSON.parse(message.stdout);
      if (typeof data.title !== "string" || !data.title.trim() || typeof data.body !== "string") {
        throw new Error("title/body inválidos");
      }
      title = data.title;
      body = data.body;
      // `commits` só enriquece o body com trailers de revert (#11216) —
      // ausente/malformado não bloqueia o merge.
      commits = Array.isArray(data.commits) ? data.commits : [];
    } catch (err) {
      return { ok: false, error: `mensagem da PR #${prNumber} ilegível: ${err instanceof Error ? err.message : String(err)}` };
    }
    const merge = runner.exec("gh", [
      "pr",
      "merge",
      String(prNumber),
      "--squash",
      "--match-head-commit",
      head.sha,
      "--subject",
      buildSoloSquashSubject(title, prNumber),
      "--body",
      buildSoloSquashBody(body, commits),
    ]);
    const mergeOk = merge.ok || confirmMerged(runner, prNumber);
    if (!mergeOk) return { ok: false, error: `gh pr merge --squash falhou (confirmado via gh pr view --json state,mergedAt): ${merge.stderr}` };
    const syncNote = syncLocalCheckoutAfterMerge(runner);
    if (syncNote) return { ok: true, error: `merge OK (confirmado); ${syncNote} (não bloqueante)` };
    return { ok: true };
  } finally {
    runner.exec("npx", ["tsx", "scripts/lib/session-registry.ts", "merge-lock-release", "--kind", opts.kind, "--session-id", opts.sessionId]);
  }
}

export interface RunMergeTrainOptions {
  sessionId: string;
  kind: string; // overnight|develop|continuo
  baseBranch?: string; // default "master"
  ciTimeoutMs?: number; // default 30 min — mesma convenção de timeout de CI já usada nas skills
  ciPollIntervalMs?: number; // default 30s
  branchPrefix?: string; // default "merge-train"
  mainCwd: string; // checkout principal — onde o worktree é adicionado/removido e onde o merge de verdade acontece
}

export interface TrainBatchOutcome {
  batch: TrainBatch;
  /**
   * `"indeterminate"` (#7064): o 1º veredito do CI do lote foi `fail`, mas a
   * reconfirmação (2ª execução, mesmo PR-trem/sha) discordou — a assinatura
   * da corrida do #7060 (merge ref ainda não recalculado), não prova de
   * defeito. Terminal, como `lock-blocked`: nunca bissecta um lote que só
   * teve um veredito ambíguo (bissectar aqui reproduziria o dano medido —
   * cada metade voltaria a rodar sozinha contra `master`, sem a outra que
   * eventualmente a "consertava", e reprovaria as duas por um problema que
   * não existe). Não reentra na fila (evita livelock se a corrida persistir
   * por config real) — exige nova invocação do trem.
   *
   * `"retido"` (#10294): o PR (sempre lote de 1) foi reprovado na condição 3
   * (`retido-para-editor`) no instante do merge — não mergeado, de
   * propósito. Terminal e NÃO é falha (o editor decide); os demais PRs do
   * lote voltam pra fila sem ele.
   *
   * `"retido-ilegivel"` (#10299): mesmo caminho do `retido` (o PR sai do lote,
   * não é mergeado — fail-closed), mas o sinal estava ILEGÍVEL no instante do
   * merge (`gh` falhou, JSON ruim). Não é retenção deliberada: conta como
   * falha real (`trainHasRealFailure`), igual ao ilegível da descoberta.
   *
   * `"threads-bloqueantes"` (#12734): a revalidação do Gate 2 no instante do
   * merge reprovou um PR do lote na condição 2 — thread(s) de review aberta(s)
   * que bloqueiam. Não é lock: o detalhe lista o PR e os IDs das threads
   * retidas (também em `blockingThreads`), pra quem lê o status ir direto à
   * leitura da thread em vez de investigar sessão concorrente. Terminal e
   * conta como falha real (trabalho pendente), como o `lock-blocked` que
   * rotulava este caso antes. O outcome é sempre do PR barrado sozinho: num
   * lote >=2, os demais PRs voltam pra fila sem ele (#12784), como no
   * `retido`.
   *
   * `"threads-ilegiveis"` (#12734, review da PR #12740): a condição 2 do
   * Gate 2 falhou por ERRO de query/paginação das threads — não há lista
   * confiável, então não é `threads-bloqueantes` (nenhuma thread aberta foi
   * confirmada) nem lock. Terminal e conta como falha real (fail-closed).
   */
  status:
    | "merged"
    | "solo-merged"
    | "solo-failed"
    | "abandoned"
    | "lock-blocked"
    | "threads-bloqueantes"
    | "threads-ilegiveis"
    | "indeterminate"
    | "retido"
    | "retido-ilegivel";
  detail: string;
  /**
   * #13509: runs de CI do PR-trem consumidos por ESTE outcome — 1 quando o
   * `pollTrainCi` do lote rodou (inclusive PR-trem de 1, #10997/#13461, e
   * lote vermelho/indeterminado), 0 quando não houve CI (merge solo direto,
   * integração ou abertura do PR-trem falhou, outcome derivado de um PR
   * tirado de um lote cujo run já foi contado). `summarizeTrainCiRuns` soma
   * este campo em vez de inferir pelo tamanho do lote.
   */
  ciRuns?: number;
  /** #12734: só em `threads-bloqueantes` — PR barrado e IDs das threads retidas. */
  blockingThreads?: { pr: number; threads: string[] };
}

/**
 * Exit code do `run-merge-train.ts` (#10299): falha real = `solo-failed`,
 * `lock-blocked`, `threads-bloqueantes`/`threads-ilegiveis` (#12734), `indeterminate`,
 * `retido-ilegivel`, ou sinal de retenção ilegível já na descoberta
 * (`retidoReadFailure`). `retido` de fato e `abandoned` (rastro de
 * bissecção) nunca contam.
 */
export function trainHasRealFailure(outcomes: readonly TrainBatchOutcome[], retidoReadFailure = false): boolean {
  return (
    retidoReadFailure ||
    outcomes.some(
      (o) =>
        o.status === "solo-failed" ||
        o.status === "lock-blocked" ||
        o.status === "threads-bloqueantes" ||
        o.status === "threads-ilegiveis" ||
        o.status === "indeterminate" ||
        o.status === "retido-ilegivel",
    )
  );
}

/**
 * Outcome `threads-bloqueantes` (#12734) a partir de um merge reprovado na
 * condição 2 do Gate 2 — ou `threads-ilegiveis` quando a condição 2 falhou
 * por erro de leitura das threads; `undefined` quando a falha não foi na
 * condição 2. O detalhe de `threads-bloqueantes` lista cada ID uma vez só (a
 * mensagem da revalidação repetiria os mesmos IDs, review da PR #12740).
 */
export function threadsBlockedOutcome(batch: TrainBatch, result: MergeTrainBatchResult): TrainBatchOutcome | undefined {
  if (result.ok) return undefined;
  if (result.threadsBlockedPr !== undefined && result.blockingThreads !== undefined) {
    const pr = result.threadsBlockedPr;
    const threads = result.blockingThreads;
    return {
      batch,
      status: "threads-bloqueantes",
      detail: `PR #${pr} com ${threads.length} thread(s) de review aberta(s) que bloqueiam (não é lock) — threads retidas: ${threads.join(", ")}`,
      blockingThreads: { pr, threads: [...threads] },
    };
  }
  if (result.threadsUnreadablePr !== undefined) {
    return {
      batch,
      status: "threads-ilegiveis",
      detail: `PR #${result.threadsUnreadablePr}: threads de review ilegíveis na revalidação do Gate 2 (não é lock, nem thread aberta confirmada) — ${result.error ?? "sem detalhe do erro"}`,
    };
  }
  return undefined;
}

const DEFAULT_CI_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CI_POLL_INTERVAL_MS = 30_000;
// Achado do fleet review: lote CI-verde que só falha no merge por causa de
// lock negado (outra sessão mergeando agora) merece retry, não descarte —
// o lote já provou que passa junto, custaria uma rodada inteira nova de
// CI pra provar de novo. Bounded (nunca infinito) e SEM bissectar (o
// tamanho do lote não muda entre tentativas) — o anti-livelock da fila
// continua garantido porque isto é um laço PRÓPRIO, não uma re-entrada na
// fila principal.
const MAX_LOCK_RETRIES = 3;
const LOCK_RETRY_DELAY_MS = 20_000;
// #7064: 1 veredito vermelho isolado do CI do lote não bissecta de cara —
// a corrida do #7060 (merge ref stale) pode produzir um "fail" que já não
// reflete a árvore atual, e bissectar em cima disso reprova 2 PRs saudáveis
// por um problema que não existe (medido ao vivo: lote com 2 hotfixes
// disjuntos, ambos rotulados solo-failed por um vermelho que a 2ª leitura
// já não reproduzia). Espera curta antes de reconfirmar — barata frente ao
// custo de bissectar (`worstCaseCiRuns(N)` runs + o dano de rotular PRs
// boas) — e não muda em nada o caminho feliz (CI verde na 1ª tentativa
// nunca passa por aqui).
const RECONFIRM_DELAY_MS = 15_000;
// #13461: quantas vezes um lote refaz a integração porque a base andou entre
// o CI do PR-trem e o merge. Cada volta custa 1 CI; acima disto o lote fica
// `lock-blocked` (validado só sobre base antiga) em vez de girar a noite toda.
const MAX_BASE_MOVED_RETRIES = 2;

/**
 * Orquestrador de topo — fila de lotes começando pelo lote inicial
 * (tipicamente a saída de `composeTrainBatches`, um item por lote). Cada
 * lote de tamanho 1 degrada pro merge solo (piso da bissecção = caminho
 * de hoje) — EXCETO o PR que já esteve num lote de CI vermelho/timeout
 * (#10997): esse lote provou que a base atual + algum dos seus PRs quebra,
 * então o CI verde do PR sobre a base antiga não vale; o PR sozinho passa
 * pela integração + PR-trem + CI sobre `origin/{base}` fresco (a
 * "revalidação da base" do #10927) e, se esse CI reprovar ou não montar,
 * termina `solo-failed` sem merge. O mesmo vale (#13461) para o PR solo cujo
 * HEAD não contém a base atual relida sob o lock (`mergeSoloPr` devolve
 * `staleBase` sem mergear). E o PR-trem verde cuja base andou antes do merge
 * refaz a integração (até `MAX_BASE_MOVED_RETRIES`, depois `lock-blocked`).
 * Lote de tamanho ≥2: monta a integração (worktree isolado),
 * abre o PR-trem, espera 1 run de CI; verde → merge de verdade (1 commit
 * squash, `Closes` de todas as issues do lote, com retry bounded se só o
 * lock estiver negado) + fecha as PRs originais; vermelho → RECONFIRMA
 * com uma 2ª execução no mesmo PR-trem antes de aceitar (#7064 — a
 * corrida do #7060 pode produzir um vermelho que já não reflete a árvore
 * atual); as 2 concordando em vermelho, ou timeout → descarta o PR-trem e
 * o worktree, bissecta, e os dois sub-lotes voltam pra fila (nunca
 * reprocessa o MESMO lote sem bissectar — anti-livelock, cada bissecção
 * estritamente reduz o tamanho até o piso de 1; a única exceção é o retry
 * de lock acima, que é um laço interno bounded, não uma re-entrada na
 * fila); as 2 execuções DISCORDANDO vira `"indeterminate"` — terminal,
 * também sem reentrar na fila, mas sem bissectar (ver docstring de
 * `TrainBatchOutcome.status`).
 *
 * Falha de INTEGRAÇÃO (conflito de merge entre branches — diferente de
 * colisão de arquivo, que `composeTrainBatches` já garante que nunca
 * acontece dentro de um lote; isto é conteúdo semanticamente incompatível,
 * ou falha de rede no fetch/push) também bissecta em vez de abortar o
 * lote inteiro — o sub-lote menor pode não ter o mesmo problema.
 */
export async function runMergeTrain(
  runner: TrainRunner,
  initialBatch: TrainBatch,
  prInfos: readonly TrainPrInfo[],
  opts: RunMergeTrainOptions,
): Promise<TrainBatchOutcome[]> {
  const baseBranch = opts.baseBranch ?? "master";
  const ciTimeoutMs = opts.ciTimeoutMs ?? DEFAULT_CI_TIMEOUT_MS;
  const ciPollIntervalMs = opts.ciPollIntervalMs ?? DEFAULT_CI_POLL_INTERVAL_MS;
  const branchPrefix = opts.branchPrefix ?? "merge-train";
  const mainCwd = opts.mainCwd;

  const outcomes: TrainBatchOutcome[] = [];
  const queue: TrainBatch[] = [initialBatch];
  let seq = 0;
  // #10997: PRs que estiveram num lote cujo CI voltou VERMELHO (confirmado)
  // ou estourou o timeout. O lote vermelho é evidência de que a base atual
  // + algum desses PRs quebra — o CI verde do próprio PR (rodado sobre a
  // base ANTIGA) já não prova nada. No piso da bissecção, um PR deste
  // conjunto nunca vai pro `mergeSoloPr` (que confia nesse CI velho):
  // passa pelo mesmo caminho do lote (branch de integração sobre
  // `origin/{base}` fresco + PR-trem + CI) e só mergeia com esse CI verde.
  // Foi o que deixou master vermelha na rodada 261023 (PR #10954).
  const needsBaseRevalidation = new Set<number>();
  // #13461: PRs que chegaram ao merge solo com a base fora do HEAD (só pro
  // detalhe do outcome) e quantas vezes cada lote viu a base andar entre o
  // CI do PR-trem e o merge (bounded por MAX_BASE_MOVED_RETRIES).
  const staleSoloPrs = new Set<number>();
  const baseMovedRetries = new Map<string, number>();

  /** Lote que não pode seguir: bissecta (>=2) ou, no piso, vira `solo-failed`
   * terminal — `bisectBatch` lança em lote de 1, e um PR sozinho que falha
   * sobre a base atual não tem metade "boa" pra isolar. */
  const failOrBisect = (batch: TrainBatch, detail: string, ciRuns: number): void => {
    if (batch.prs.length === 1) {
      outcomes.push({ batch, status: "solo-failed", detail: `${detail} — PR sozinho sobre a base atual, sem merge (#10997)`, ciRuns });
      return;
    }
    const [left, right] = bisectBatch(batch);
    queue.push(left, right);
    outcomes.push({ batch, status: "abandoned", detail: `${detail}, bissectando`, ciRuns });
  };

  while (queue.length > 0) {
    const batch = queue.shift();
    if (!batch || batch.prs.length === 0) continue; // defensivo — nunca deveria acontecer (bisectBatch nunca produz lote vazio)

    if (batch.prs.length === 1 && !needsBaseRevalidation.has(batch.prs[0])) {
      const pr = batch.prs[0];
      const result = mergeSoloPr(runner, pr, { sessionId: opts.sessionId, kind: opts.kind, baseBranch });
      if (result.staleBase) {
        // #13461: a base andou depois do último push desta PR — o CI verde
        // dela não prova a combinação com o que entrou. Nada foi mergeado;
        // a PR volta à frente da fila pelo caminho do PR-trem de 1 (mesma
        // revalidação do #10997). Bounded: a PR nunca mais passa por aqui.
        needsBaseRevalidation.add(pr);
        staleSoloPrs.add(pr);
        runner.warn(`${result.error} — revalidando sobre a base atual pelo PR-trem de 1 em vez do merge solo`);
        queue.unshift(batch);
        continue;
      }
      const threadsOutcome = threadsBlockedOutcome(batch, result); // #12734
      if (threadsOutcome) {
        outcomes.push({ ...threadsOutcome, ciRuns: 0 });
        continue;
      }
      const soloStatus = result.ok
        ? "solo-merged"
        : result.retidoPr === undefined
          ? "solo-failed"
          : result.retidoIlegivel
            ? "retido-ilegivel"
            : "retido";
      outcomes.push({ batch, status: soloStatus, detail: result.error ?? "sem trem — merge solo", ciRuns: 0 });
      continue;
    }

    seq++;
    const branchName = `${branchPrefix}/lote-${seq}-${batch.prs.join("-")}`;
    const integ = buildIntegrationBranch(runner, batch, prInfos, { baseBranch, branchName, mainCwd });
    if (!integ.ok) {
      // Achado do fleet review: SEMPRE limpar (remove o worktree) antes de
      // bissectar — o worktree isolado nunca poluiu o checkout principal,
      // mas ainda assim é um diretório temp e uma branch local que não
      // devem sobreviver além deste lote.
      cleanupIntegrationBranch(runner, integ.branchName, integ.worktreePath, mainCwd);
      failOrBisect(batch, `integração falhou (${integ.error})`, 0);
      continue;
    }

    let trainPrNumber: number;
    try {
      trainPrNumber = openTrainPr(runner, branchName, baseBranch, buildTrainPrTitle(batch), buildTrainPrBody(batch, prInfos));
    } catch (err) {
      cleanupIntegrationBranch(runner, branchName, integ.worktreePath, mainCwd);
      failOrBisect(batch, `abrir PR-trem falhou (${err instanceof Error ? err.message : String(err)})`, 0);
      continue;
    }
    applyTrainGateLabels(runner, trainPrNumber, batch, prInfos); // #11019

    const verdict = await pollTrainCi(runner, trainPrNumber, { timeoutMs: ciTimeoutMs, intervalMs: ciPollIntervalMs });

    if (verdict === "pass") {
      let mergeResult = mergeTrainBatch(runner, trainPrNumber, batch, prInfos, {
        sessionId: opts.sessionId,
        kind: opts.kind,
        commitTitle: buildTrainMergeCommitTitle(batch),
        commitBody: buildTrainMergeCommitBody(batch, prInfos),
        baseBranch,
      });
      let lockRetries = 0;
      while (!mergeResult.ok && mergeResult.lockDenied && lockRetries < MAX_LOCK_RETRIES) {
        lockRetries++;
        await runner.sleep(LOCK_RETRY_DELAY_MS);
        mergeResult = mergeTrainBatch(runner, trainPrNumber, batch, prInfos, {
          sessionId: opts.sessionId,
          kind: opts.kind,
          commitTitle: buildTrainMergeCommitTitle(batch),
          commitBody: buildTrainMergeCommitBody(batch, prInfos),
          baseBranch,
        });
      }
      // O PR-trem SÓ é fechado explicitamente se o merge não aconteceu —
      // se mergeou, `gh pr merge` já fecha o PR-trem sozinho (é o próprio
      // objeto mergeado).
      if (!mergeResult.ok) {
        runner.exec("gh", ["pr", "close", String(trainPrNumber)]);
      }
      cleanupIntegrationBranch(runner, branchName, integ.worktreePath, mainCwd);
      if (mergeResult.ok && batch.prs.length === 1) {
        // #10997: PR sozinho revalidado sobre a base atual (veio de um lote
        // vermelho, ou, #13461, de um merge solo com a base fora do HEAD).
        const why = staleSoloPrs.has(batch.prs[0]) ? "estava atrás da base atual, #13461" : "#10997";
        outcomes.push({
          batch,
          status: "solo-merged",
          detail: mergeResult.error ?? `revalidado sobre a base atual (PR-trem #${trainPrNumber}, CI verde) e squash-mergeado (${why})`,
          ciRuns: 1,
        });
      } else if (mergeResult.staleBase) {
        // #13461: a base andou entre o CI do PR-trem e o merge (outra sessão
        // mergeou no meio). Nada mergeado; a integração é refeita sobre a base
        // nova, no máximo MAX_BASE_MOVED_RETRIES vezes por lote.
        const key = batch.prs.join(",");
        const seen = (baseMovedRetries.get(key) ?? 0) + 1;
        baseMovedRetries.set(key, seen);
        if (seen <= MAX_BASE_MOVED_RETRIES) {
          outcomes.push({ batch, status: "abandoned", detail: `${mergeResult.error} — integração refeita sobre a base nova (tentativa ${seen}/${MAX_BASE_MOVED_RETRIES})`, ciRuns: 1 });
          queue.unshift(batch);
        } else {
          outcomes.push({
            batch,
            status: "lock-blocked",
            detail: `base andou ${seen}x entre o CI do PR-trem e o merge — lote validado só sobre base antiga, não mergeado: ${mergeResult.error}`,
            ciRuns: 1,
          });
        }
      } else if (mergeResult.ok) {
        outcomes.push({ batch, status: "merged", detail: mergeResult.error ?? `PR-trem #${trainPrNumber} squash-mergeado`, ciRuns: 1 });
      } else if (mergeResult.retidoPr !== undefined) {
        // #10294: 1 PR do lote ficou retido para o editor DEPOIS da
        // descoberta. Nunca prende o resto: o retido sai (terminal
        // `retido`) e os demais voltam pra fila como lote estritamente
        // menor — anti-livelock preservado (cada re-entrada encolhe o lote).
        const retidoPr = mergeResult.retidoPr;
        const rest = batch.prs.filter((p) => p !== retidoPr);
        outcomes.push({ batch, status: "abandoned", detail: `PR #${retidoPr} retido no instante do merge — lote refeito sem ele: ${mergeResult.error}`, ciRuns: 1 });
        outcomes.push({
          batch: { prs: [retidoPr] },
          status: mergeResult.retidoIlegivel ? "retido-ilegivel" : "retido",
          detail: mergeResult.error ?? "retido-para-editor",
          ciRuns: 0, // o run do lote já foi contado na entrada `abandoned` acima
        });
        if (rest.length > 0) queue.push({ prs: rest });
      } else if (mergeResult.threadsBlockedPr !== undefined && mergeResult.blockingThreads !== undefined && batch.prs.length > 1) {
        // #12784: thread de review aberta é estado de UM PR, como a retenção
        // acima — o PR com thread sai (terminal `threads-bloqueantes`, com os
        // IDs) e os demais voltam pra fila como lote estritamente menor, em
        // vez de o lote inteiro terminar barrado. Anti-livelock preservado
        // (cada re-entrada encolhe o lote). `threads-ilegiveis` NÃO segue este
        // caminho: erro de leitura das threads tende a ser da API, não do PR,
        // e segue terminal pro lote inteiro (fail-closed).
        const blockedPr = mergeResult.threadsBlockedPr;
        const rest = batch.prs.filter((p) => p !== blockedPr);
        outcomes.push({
          batch,
          status: "abandoned",
          detail: `PR #${blockedPr} com thread(s) de review aberta(s) no instante do merge — lote refeito sem ele: ${mergeResult.error}`,
          ciRuns: 1,
        });
        const blockedOutcome = threadsBlockedOutcome({ prs: [blockedPr] }, mergeResult);
        if (blockedOutcome) outcomes.push({ ...blockedOutcome, ciRuns: 0 }); // run já contado na entrada `abandoned`
        if (rest.length > 0) queue.push({ prs: rest });
      } else if (mergeResult.lockDenied) {
        // Esgotou os retries e o lock continua negado — achado do fleet
        // review: isto NÃO É "abandoned" (que significa "vermelho, vai
        // bissectar") — é um estado terminal distinto e visível: um lote
        // que PROVOU que passa junto, mas não conseguiu a janela de merge.
        // `run-merge-train.ts` trata isto como falha real (exit != 0).
        outcomes.push({
          batch,
          status: "lock-blocked",
          detail: `lock negado após ${MAX_LOCK_RETRIES} tentativas — lote validado (CI verde) mas não mergeado: ${mergeResult.error}`,
          ciRuns: 1,
        });
      } else {
        // Falha de merge que NÃO é lock — também não bissecta (o problema
        // não é sobre QUAIS PRs formam o lote, é sobre o estado de um PR
        // específico) e conta como falha real pro exit code. Thread de
        // review aberta (condição 2 do Gate 2) ganha rótulo próprio com os
        // IDs das threads (#12734): sob `lock-blocked`, quem lia só o status
        // ia investigar sessão concorrente; erro de leitura das threads vira
        // `threads-ilegiveis`. O resto (CI regrediu, claims,
        // gh pr merge falhou por outro motivo) segue no rótulo genérico.
        outcomes.push({
          ...(threadsBlockedOutcome(batch, mergeResult) ?? { batch, status: "lock-blocked", detail: `merge falhou (não-lock): ${mergeResult.error}` }),
          ciRuns: 1,
        });
      }
      continue;
    }

    // #7064: um "fail" isolado não bissecta de cara — reconfirma com uma 2ª
    // execução no MESMO PR-trem (mesmo sha, nenhum código tocado) antes de
    // tratar como reprovação real. Timeout NÃO reconfirma (já esgotou o
    // orçamento de espera — reconfirmar dobraria o custo sem atacar a causa
    // da corrida, que é sobre os primeiros segundos após o push do PR-trem,
    // não sobre CI lento).
    let finalVerdict: TrainCiVerdict = verdict;
    let reconfirmNote = "";
    if (verdict === "fail") {
      await runner.sleep(RECONFIRM_DELAY_MS);
      const reconfirmVerdict = await pollTrainCi(runner, trainPrNumber, { timeoutMs: ciTimeoutMs, intervalMs: ciPollIntervalMs });
      if (reconfirmVerdict !== "fail") {
        // Discordância entre as 2 execuções = a assinatura da corrida do
        // #7060 (merge ref ainda não recalculado) — nunca reprovação, nunca
        // bissecta. Estado terminal distinto (ver docstring de
        // TrainBatchOutcome.status): não reentra na fila, exige nova
        // invocação do trem.
        runner.exec("gh", ["pr", "close", String(trainPrNumber)]);
        cleanupIntegrationBranch(runner, branchName, integ.worktreePath, mainCwd);
        outcomes.push({
          batch,
          status: "indeterminate",
          detail:
            `1ª execução do CI do lote: fail; reconfirmação (2ª execução, mesmo sha): ${reconfirmVerdict} — ` +
            "discordância, assinatura de corrida (#7060/#7064); lote NÃO bissectado, requer nova tentativa",
          ciRuns: 1, // a reconfirmação relê o mesmo run (mesmo sha), não dispara outro
        });
        continue;
      }
      finalVerdict = "fail";
      reconfirmNote = " (reconfirmado — 2ª execução também vermelha)";
    }

    // Vermelho confirmado nas 2 execuções, ou timeout — descarta o PR-trem
    // (nunca mergear por engano) e o worktree, bissecta. Todo PR do lote
    // passa a exigir CI sobre a base atual até o merge (#10997).
    runner.exec("gh", ["pr", "close", String(trainPrNumber)]);
    cleanupIntegrationBranch(runner, branchName, integ.worktreePath, mainCwd);
    for (const pr of batch.prs) needsBaseRevalidation.add(pr);
    failOrBisect(batch, `CI do lote: ${finalVerdict}${reconfirmNote}`, 1);
  }

  return outcomes;
}
