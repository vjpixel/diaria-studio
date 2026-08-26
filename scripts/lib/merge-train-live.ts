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
 */

import { spawnSync } from "node:child_process";
import {
  parseClosesIssues,
  bisectBatch,
  buildTrainPrTitle,
  buildTrainPrBody,
  buildTrainMergeCommitTitle,
  buildTrainMergeCommitBody,
  type TrainBatch,
  type TrainPrInfo,
} from "./merge-train.ts";
import { evaluatePrChecksGate } from "./pr-checks-gate.ts";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface TrainRunner {
  exec(cmd: string, args: string[]): ExecResult;
  sleep(ms: number): Promise<void>;
  /** ms desde uma origem arbitrária monotônica — só usado pra medir elapsed, nunca gravado. */
  now(): number;
}

/** Runner real — `spawnSync`, timeout de 60s por chamada individual (não é
 * o timeout do POLLING de CI, que é orquestrado por `pollTrainCi` chamando
 * este `exec` várias vezes). */
export function createRealTrainRunner(cwd: string): TrainRunner {
  return {
    exec(cmd, args) {
      const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
      if (r.error) return { ok: false, stdout: "", stderr: r.error.message };
      return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** Busca metadados reais de um PR (`gh pr view`) e extrai as issues que
 * ele fecha do próprio corpo (`parseClosesIssues`, mesmo parser que
 * `buildTrainPrBody`/`buildTrainMergeCommitBody` consomem via `TrainPrInfo`). */
export function fetchTrainPrInfo(runner: TrainRunner, prNumber: number): TrainPrInfo {
  const res = runner.exec("gh", ["pr", "view", String(prNumber), "--json", "number,headRefName,title,body"]);
  if (!res.ok) throw new Error(`fetchTrainPrInfo: gh pr view falhou pro PR #${prNumber}: ${res.stderr}`);
  const parsed: unknown = JSON.parse(res.stdout);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`fetchTrainPrInfo: PR #${prNumber} — JSON inesperado de gh pr view`);
  }
  const p = parsed as { number: number; headRefName: string; title: string; body: string };
  return {
    pr: p.number,
    headRefName: p.headRefName,
    title: p.title,
    issueNumbers: parseClosesIssues(p.body ?? ""),
  };
}

export interface IntegrationBranchResult {
  ok: boolean;
  branchName: string;
  /** Presente só quando ok=false — o PR cujo merge conflitou (bisecção usa isto pra decidir o corte, embora hoje bisseque ao meio sempre — ver runMergeTrain). */
  conflictOnPr?: number;
  error?: string;
}

/**
 * Monta a branch de integração: parte de `origin/{baseBranch}` fresco e
 * faz `git merge --no-ff` de cada PR do lote EM SEQUÊNCIA (não
 * `git rebase` literal — decisão de implementação: como por construção
 * nenhum PR do lote colide em arquivo com outro, `git merge` aplica limpo
 * sem risco de reescrever commits/hashes que um rebase de verdade traria;
 * atinge o MESMO objetivo do critério de aceite — validar a COMBINAÇÃO
 * dos K com 1 run de CI — com uma primitiva git mais simples e previsível).
 * Push da branch pro remoto ao final, pronta pra abrir o PR-trem.
 */
export function buildIntegrationBranch(
  runner: TrainRunner,
  batch: TrainBatch,
  prInfos: readonly TrainPrInfo[],
  opts: { baseBranch: string; branchName: string },
): IntegrationBranchResult {
  const byNumber = new Map(prInfos.map((p) => [p.pr, p]));

  const fetchBase = runner.exec("git", ["fetch", "origin", opts.baseBranch]);
  if (!fetchBase.ok) return { ok: false, branchName: opts.branchName, error: `git fetch base falhou: ${fetchBase.stderr}` };

  const createBranch = runner.exec("git", ["checkout", "-b", opts.branchName, `origin/${opts.baseBranch}`]);
  if (!createBranch.ok) {
    return { ok: false, branchName: opts.branchName, error: `git checkout -b falhou: ${createBranch.stderr}` };
  }

  for (const pr of batch.prs) {
    const info = byNumber.get(pr);
    if (!info) {
      return { ok: false, branchName: opts.branchName, conflictOnPr: pr, error: `PR #${pr} sem TrainPrInfo — não deveria acontecer` };
    }
    const fetchPr = runner.exec("git", ["fetch", "origin", info.headRefName]);
    if (!fetchPr.ok) {
      return { ok: false, branchName: opts.branchName, conflictOnPr: pr, error: `git fetch da branch do PR #${pr} falhou: ${fetchPr.stderr}` };
    }
    const merge = runner.exec("git", ["merge", "--no-edit", "--no-ff", "FETCH_HEAD"]);
    if (!merge.ok) {
      // Aborta o merge conflituoso pra deixar o checkout limpo — quem
      // chama decide o próximo passo (bisecção), não precisa lidar com
      // estado de merge pela metade.
      runner.exec("git", ["merge", "--abort"]);
      return { ok: false, branchName: opts.branchName, conflictOnPr: pr, error: `merge do PR #${pr} conflitou: ${merge.stderr}` };
    }
  }

  const push = runner.exec("git", ["push", "-u", "origin", opts.branchName]);
  if (!push.ok) return { ok: false, branchName: opts.branchName, error: `git push falhou: ${push.stderr}` };

  return { ok: true, branchName: opts.branchName };
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
      try {
        const parsed: unknown = JSON.parse(res.stdout);
        const rollup =
          typeof parsed === "object" && parsed !== null && "statusCheckRollup" in parsed
            ? (parsed as { statusCheckRollup: unknown }).statusCheckRollup
            : undefined;
        const gate = evaluatePrChecksGate(rollup);
        if (gate.verdict === "pass") return "pass";
        if (gate.verdict === "fail") return "fail";
        // "pending" ou "error" (JSON malformado/gh falhou nesta rodada específica) — tenta de novo até o timeout.
      } catch {
        // JSON malformado nesta rodada — trata como pending, tenta de novo.
      }
    }
    if (runner.now() - start >= opts.timeoutMs) return "timeout";
    await runner.sleep(opts.intervalMs);
  }
}

export interface MergeTrainBatchResult {
  ok: boolean;
  error?: string;
}

/**
 * Merge de verdade: adquire o merge lock cross-sessão
 * (`session-registry.ts merge-lock-acquire`), squash-merge do PR-trem com
 * 1 commit fechando todas as issues do lote, `git pull` (janela protegida
 * do lock — só isso, ver docstring de `merge-lock-acquire` em
 * `session-registry.ts`), libera o lock, e fecha cada PR ORIGINAL do lote
 * com um comentário apontando pro commit squash (GitHub não teria como
 * auto-fechá-los sozinho — o código deles chegou em master por uma branch
 * DIFERENTE, a de integração, não a deles).
 *
 * `denied` no lock não é erro fatal — degrada pro chamador decidir
 * retry/abort (ver `runMergeTrain`), nunca insiste sozinho aqui dentro.
 */
export function mergeTrainBatch(
  runner: TrainRunner,
  trainPrNumber: number,
  batch: TrainBatch,
  prInfos: readonly TrainPrInfo[],
  opts: { sessionId: string; kind: string; commitTitle: string; commitBody: string; mergeCommitSha?: (sha: string) => void },
): MergeTrainBatchResult {
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
    return { ok: false, error: `merge-lock-acquire negado (outra sessão mergeando agora): ${acquire.stderr || acquire.stdout}` };
  }

  try {
    const merge = runner.exec("gh", [
      "pr",
      "merge",
      String(trainPrNumber),
      "--squash",
      "--subject",
      opts.commitTitle,
      "--body",
      opts.commitBody,
    ]);
    if (!merge.ok) {
      return { ok: false, error: `gh pr merge --squash falhou: ${merge.stderr}` };
    }

    const pull = runner.exec("git", ["pull"]);
    if (!pull.ok) {
      // O merge JÁ aconteceu no remoto — não é um "ok: false" no sentido de
      // "nada mudou"; é um estado local defasado. Reporta, mas quem chama
      // trata como sucesso pro fluxo de fechar as PRs originais (o commit
      // squash já existe no GitHub, é o que os comentários de fechamento
      // referenciam — não depende do checkout local estar sincronizado).
      runner.exec("npx", ["tsx", "scripts/lib/session-registry.ts", "merge-lock-release", "--kind", opts.kind, "--session-id", opts.sessionId]);
      return { ok: true, error: `merge OK, mas git pull local falhou (não bloqueante): ${pull.stderr}` };
    }
  } finally {
    runner.exec("npx", ["tsx", "scripts/lib/session-registry.ts", "merge-lock-release", "--kind", opts.kind, "--session-id", opts.sessionId]);
  }

  // Fechar as PRs ORIGINAIS do lote — o código delas já está em master via
  // squash do PR-trem, mas o GitHub não sabe disso sozinho (branches
  // diferentes). Best-effort por PR: uma falha aqui não desfaz o merge que
  // já aconteceu, só fica sem o comentário/close — reportado, não fatal.
  const closeFailures: string[] = [];
  for (const pr of batch.prs) {
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

  return closeFailures.length > 0 ? { ok: true, error: closeFailures.join("; ") } : { ok: true };
}

/** Remove a branch de integração (remoto + local) — chamado depois de
 * mergear (limpeza) OU depois de descartar por vermelho/bisecção (a
 * branch já cumpriu o papel dela, novos lotes usam nome novo). */
export function cleanupIntegrationBranch(runner: TrainRunner, branchName: string): void {
  runner.exec("git", ["push", "origin", "--delete", branchName]);
  runner.exec("git", ["checkout", "master"]);
  runner.exec("git", ["branch", "-D", branchName]);
}

export interface MergeSoloOptions {
  sessionId: string;
  kind: string;
}

/** Piso da bissecção = caminho de HOJE, sem trem: merge direto do PR
 * (já validado individualmente — este é o merge que TODA sessão autônoma
 * já faz pra cada PR fora do trem), sob o mesmo merge lock. Reusa a
 * própria mensagem do PR (`gh pr merge --squash` sem `--subject`/`--body`
 * customizado) — diferente de `mergeTrainBatch`, que PRECISA de mensagem
 * custom porque combina >1 PR num commit só. */
export function mergeSoloPr(runner: TrainRunner, prNumber: number, opts: MergeSoloOptions): MergeTrainBatchResult {
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
    return { ok: false, error: `merge-lock-acquire negado (outra sessão mergeando agora): ${acquire.stderr || acquire.stdout}` };
  }
  try {
    const merge = runner.exec("gh", ["pr", "merge", String(prNumber), "--squash"]);
    if (!merge.ok) return { ok: false, error: `gh pr merge --squash falhou: ${merge.stderr}` };
    const pull = runner.exec("git", ["pull"]);
    if (!pull.ok) return { ok: true, error: `merge OK, mas git pull local falhou (não bloqueante): ${pull.stderr}` };
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
}

export interface TrainBatchOutcome {
  batch: TrainBatch;
  status: "merged" | "solo-merged" | "solo-failed" | "abandoned";
  detail: string;
}

const DEFAULT_CI_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CI_POLL_INTERVAL_MS = 30_000;

/**
 * Orquestrador de topo — fila de lotes começando pelo lote inicial
 * (tipicamente a saída de `composeTrainBatches`, um item por lote). Cada
 * lote de tamanho 1 degrada pro merge solo (piso da bissecção = caminho
 * de hoje). Lote de tamanho ≥2: monta a integração, abre o PR-trem,
 * espera 1 run de CI; verde → merge de verdade (1 commit squash,
 * `Closes` de todas as issues do lote) + fecha as PRs originais; vermelho
 * ou timeout → descarta o PR-trem e a branch, bissecta, e os dois
 * sub-lotes voltam pra fila (nunca reprocessa o MESMO lote — anti-livelock,
 * cada bissecção estritamente reduz o tamanho até o piso de 1).
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

  const outcomes: TrainBatchOutcome[] = [];
  const queue: TrainBatch[] = [initialBatch];
  let seq = 0;

  while (queue.length > 0) {
    const batch = queue.shift();
    if (!batch || batch.prs.length === 0) continue; // defensivo — nunca deveria acontecer (bisectBatch nunca produz lote vazio)

    if (batch.prs.length === 1) {
      const pr = batch.prs[0];
      const result = mergeSoloPr(runner, pr, opts);
      outcomes.push({ batch, status: result.ok ? "solo-merged" : "solo-failed", detail: result.error ?? "sem trem — merge solo" });
      continue;
    }

    seq++;
    const branchName = `${branchPrefix}/lote-${seq}-${batch.prs.join("-")}`;
    const integ = buildIntegrationBranch(runner, batch, prInfos, { baseBranch, branchName });
    if (!integ.ok) {
      const [left, right] = bisectBatch(batch);
      queue.push(left, right);
      outcomes.push({ batch, status: "abandoned", detail: `integração falhou, bissectando: ${integ.error}` });
      continue;
    }

    let trainPrNumber: number;
    try {
      trainPrNumber = openTrainPr(runner, branchName, baseBranch, buildTrainPrTitle(batch), buildTrainPrBody(batch, prInfos));
    } catch (err) {
      cleanupIntegrationBranch(runner, branchName);
      const [left, right] = bisectBatch(batch);
      queue.push(left, right);
      outcomes.push({ batch, status: "abandoned", detail: `abrir PR-trem falhou, bissectando: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const verdict = await pollTrainCi(runner, trainPrNumber, { timeoutMs: ciTimeoutMs, intervalMs: ciPollIntervalMs });

    if (verdict === "pass") {
      const mergeResult = mergeTrainBatch(runner, trainPrNumber, batch, prInfos, {
        sessionId: opts.sessionId,
        kind: opts.kind,
        commitTitle: buildTrainMergeCommitTitle(batch),
        commitBody: buildTrainMergeCommitBody(batch, prInfos),
      });
      cleanupIntegrationBranch(runner, branchName);
      outcomes.push({
        batch,
        status: mergeResult.ok ? "merged" : "abandoned",
        detail: mergeResult.error ?? `PR-trem #${trainPrNumber} squash-mergeado`,
      });
      // merge-lock negado (`mergeResult.ok === false`) não bissecta — não é
      // sinal de que o LOTE está quebrado, é sinal de que outra sessão está
      // mergeando agora. O lote já provou que passa junto (CI verde); vale
      // mais retry do lock que desmontar um lote bom. Fora de escopo desta
      // 1ª versão (ver limitação registrada no cabeçalho do módulo) —
      // registrado como `abandoned`, résiduo pra próxima iteração.
      continue;
    }

    // Vermelho ou timeout — descarta o PR-trem (nunca mergear por engano)
    // e a branch, bissecta.
    runner.exec("gh", ["pr", "close", String(trainPrNumber)]);
    cleanupIntegrationBranch(runner, branchName);
    const [left, right] = bisectBatch(batch);
    queue.push(left, right);
    outcomes.push({ batch, status: "abandoned", detail: `CI do lote: ${verdict} — bissectando` });
  }

  return outcomes;
}
