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
 * do merge — ver a nota de simplificação no docstring da função (sem o
 * carve-out FORBIDDEN completo, que pertence à sessão do review original).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
export function createRealTrainRunner(defaultCwd: string): TrainRunner {
  return {
    exec(cmd, args, cwd) {
      const r = spawnSync(cmd, args, { cwd: cwd ?? defaultCwd, encoding: "utf8", timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
      if (r.error) return { ok: false, stdout: "", stderr: r.error.message };
      return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    mkTempDir: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
    warn: (message) => console.error(`run-merge-train: AVISO — ${message}`),
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

export interface Gate2Result {
  ok: boolean;
  reason?: string;
}

/**
 * Revalidação do Gate 2 (as 2 condições) imediatamente antes de mergear —
 * chamada por `mergeTrainBatch` (por PR do lote) e `mergeSoloPr` (pro PR
 * único). Simplificação DELIBERADA da condição 2 em relação ao Gate 2 "de
 * origem" documentado nas 3 SKILL.md: aqui NÃO há carve-out de threads
 * FORBIDDEN — esse bookkeeping (quais threads retornaram FORBIDDEN durante
 * a resolução) pertence à sessão que fez o review original e não é
 * re-derivável aqui só relendo o PR. Efeito: mais CONSERVADOR que o Gate 2
 * de origem, nunca menos seguro — na pior hipótese um PR com só uma
 * thread FORBIDDEN pendente falha esta revalidação e cai pro caminho
 * normal (fora do trem), onde o Gate 2 completo decide com o carve-out
 * certo; nunca o inverso (nunca merge algo que a condição 2 de verdade
 * teria barrado). Também não pagina além de 100 threads (limite generoso,
 * mesmo usado no `first:100` da query original das SKILL.md).
 */
export function revalidateGate2(runner: TrainRunner, prNumber: number): Gate2Result {
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

  const query = `query { repository(owner:"vjpixel",name:"diaria-studio"){ pullRequest(number:${prNumber}){ reviewThreads(first:100){ nodes{ isResolved } } } } }`;
  const graphql = runner.exec("gh", ["api", "graphql", "-f", `query=${query}`]);
  if (!graphql.ok) return { ok: false, reason: `gh api graphql (threads) falhou: ${graphql.stderr}` };

  let unresolvedCount: number;
  try {
    const parsed = JSON.parse(graphql.stdout) as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: { isResolved: boolean }[] } } } };
    };
    const nodes = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    unresolvedCount = nodes.filter((n) => n.isResolved === false).length;
  } catch (e) {
    return { ok: false, reason: `JSON malformado de gh api graphql (threads): ${e instanceof Error ? e.message : String(e)}` };
  }
  if (unresolvedCount > 0) {
    return { ok: false, reason: `condição 2 (threads) — ${unresolvedCount} não resolvida(s) (sem carve-out FORBIDDEN nesta revalidação, ver docstring)` };
  }

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
}

/**
 * Verifica o estado REAL do PR via `gh pr view --json state,mergedAt`
 * (#573 — nunca confiar só no exit code de `gh pr merge`: o merge pode ter
 * tido sucesso no remoto com uma falha puramente local/transitória do
 * comando). Usado depois de QUALQUER tentativa de `gh pr merge`, sucesso
 * ou falha reportada — se o estado real diz `MERGED`, o merge aconteceu,
 * ponto final, independente do que o exit code do comando alegou.
 */
function confirmMerged(runner: TrainRunner, prNumber: number): boolean {
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
 * Merge de verdade: revalida o Gate 2 de CADA PR original do lote
 * (`revalidateGate2` — estado pode ter mudado desde a descoberta), adquire
 * o merge lock cross-sessão (`session-registry.ts merge-lock-acquire`),
 * squash-merge do PR-trem com 1 commit fechando todas as issues do lote,
 * confirma o merge via estado real (`confirmMerged`, #573), `git pull`
 * (janela protegida do lock — só isso, ver docstring de
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
  opts: { sessionId: string; kind: string; commitTitle: string; commitBody: string },
): MergeTrainBatchResult {
  for (const pr of batch.prs) {
    const gate = revalidateGate2(runner, pr);
    if (!gate.ok) {
      return { ok: false, error: `revalidação de Gate 2 falhou pro PR #${pr}: ${gate.reason}` };
    }
  }

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
    mergeOk = merge.ok || confirmMerged(runner, trainPrNumber);
    if (!mergeOk) {
      return { ok: false, error: `gh pr merge --squash falhou (confirmado via gh pr view --json state,mergedAt): ${merge.stderr}` };
    }

    const pull = runner.exec("git", ["pull"]);
    if (!pull.ok) {
      // O merge JÁ aconteceu no remoto (confirmado acima) — não é um
      // "ok: false" no sentido de "nada mudou"; é um estado local
      // defasado. Reporta, mas trata como sucesso pro fluxo de fechar as
      // PRs originais (o commit squash já existe no GitHub, é o que os
      // comentários de fechamento referenciam — não depende do checkout
      // local estar sincronizado).
      return { ok: true, error: `merge OK (confirmado), mas git pull local falhou (não bloqueante): ${pull.stderr}` };
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
  runner.exec("git", ["push", "origin", "--delete", branchName], mainCwd); // best-effort — branch pode nunca ter sido pushada
  const deleteLocal = runner.exec("git", ["branch", "-D", branchName], mainCwd);
  if (!deleteLocal.ok && removeWorktree.ok) {
    // Só reporta se o worktree FOI removido (senão a falha de branch -D é
    // esperada — git recusa deletar branch ainda checked out em worktree).
    runner.warn(`git branch -D ${branchName} falhou após remover o worktree: ${deleteLocal.stderr}`);
  }
  return removeWorktree.ok ? { ok: true } : { ok: false, error: `worktree remove falhou: ${removeWorktree.stderr}` };
}

export interface MergeSoloOptions {
  sessionId: string;
  kind: string;
}

/** Piso da bissecção = caminho de HOJE, sem trem: revalida o Gate 2 do PR
 * (mesma revalidação que `mergeTrainBatch` faz por PR do lote) e mergeia
 * direto sob o mesmo merge lock, confirmando via estado real (#573).
 * Reusa a própria mensagem do PR (`gh pr merge --squash` sem
 * `--subject`/`--body` customizado) — diferente de `mergeTrainBatch`, que
 * PRECISA de mensagem custom porque combina >1 PR num commit só. */
export function mergeSoloPr(runner: TrainRunner, prNumber: number, opts: MergeSoloOptions): MergeTrainBatchResult {
  const gate = revalidateGate2(runner, prNumber);
  if (!gate.ok) return { ok: false, error: `revalidação de Gate 2 falhou: ${gate.reason}` };

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
    const merge = runner.exec("gh", ["pr", "merge", String(prNumber), "--squash"]);
    const mergeOk = merge.ok || confirmMerged(runner, prNumber);
    if (!mergeOk) return { ok: false, error: `gh pr merge --squash falhou (confirmado via gh pr view --json state,mergedAt): ${merge.stderr}` };
    const pull = runner.exec("git", ["pull"]);
    if (!pull.ok) return { ok: true, error: `merge OK (confirmado), mas git pull local falhou (não bloqueante): ${pull.stderr}` };
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
  status: "merged" | "solo-merged" | "solo-failed" | "abandoned" | "lock-blocked";
  detail: string;
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

/**
 * Orquestrador de topo — fila de lotes começando pelo lote inicial
 * (tipicamente a saída de `composeTrainBatches`, um item por lote). Cada
 * lote de tamanho 1 degrada pro merge solo (piso da bissecção = caminho
 * de hoje). Lote de tamanho ≥2: monta a integração (worktree isolado),
 * abre o PR-trem, espera 1 run de CI; verde → merge de verdade (1 commit
 * squash, `Closes` de todas as issues do lote, com retry bounded se só o
 * lock estiver negado) + fecha as PRs originais; vermelho ou timeout →
 * descarta o PR-trem e o worktree, bissecta, e os dois sub-lotes voltam
 * pra fila (nunca reprocessa o MESMO lote sem bissectar — anti-livelock,
 * cada bissecção estritamente reduz o tamanho até o piso de 1; a única
 * exceção é o retry de lock acima, que é um laço interno bounded, não uma
 * re-entrada na fila).
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
    const integ = buildIntegrationBranch(runner, batch, prInfos, { baseBranch, branchName, mainCwd });
    if (!integ.ok) {
      // Achado do fleet review: SEMPRE limpar (remove o worktree) antes de
      // bissectar — o worktree isolado nunca poluiu o checkout principal,
      // mas ainda assim é um diretório temp e uma branch local que não
      // devem sobreviver além deste lote.
      cleanupIntegrationBranch(runner, integ.branchName, integ.worktreePath, mainCwd);
      const [left, right] = bisectBatch(batch);
      queue.push(left, right);
      outcomes.push({ batch, status: "abandoned", detail: `integração falhou, bissectando: ${integ.error}` });
      continue;
    }

    let trainPrNumber: number;
    try {
      trainPrNumber = openTrainPr(runner, branchName, baseBranch, buildTrainPrTitle(batch), buildTrainPrBody(batch, prInfos));
    } catch (err) {
      cleanupIntegrationBranch(runner, branchName, integ.worktreePath, mainCwd);
      const [left, right] = bisectBatch(batch);
      queue.push(left, right);
      outcomes.push({ batch, status: "abandoned", detail: `abrir PR-trem falhou, bissectando: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const verdict = await pollTrainCi(runner, trainPrNumber, { timeoutMs: ciTimeoutMs, intervalMs: ciPollIntervalMs });

    if (verdict === "pass") {
      let mergeResult = mergeTrainBatch(runner, trainPrNumber, batch, prInfos, {
        sessionId: opts.sessionId,
        kind: opts.kind,
        commitTitle: buildTrainMergeCommitTitle(batch),
        commitBody: buildTrainMergeCommitBody(batch, prInfos),
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
        });
      }
      // O PR-trem SÓ é fechado explicitamente se o merge não aconteceu —
      // se mergeou, `gh pr merge` já fecha o PR-trem sozinho (é o próprio
      // objeto mergeado).
      if (!mergeResult.ok) {
        runner.exec("gh", ["pr", "close", String(trainPrNumber)]);
      }
      cleanupIntegrationBranch(runner, branchName, integ.worktreePath, mainCwd);
      if (mergeResult.ok) {
        outcomes.push({ batch, status: "merged", detail: mergeResult.error ?? `PR-trem #${trainPrNumber} squash-mergeado` });
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
        });
      } else {
        // Falha de merge que NÃO é lock (ex: revalidação de Gate 2 falhou
        // pra 1+ PR do lote, ou gh pr merge falhou por outro motivo) —
        // também não bissecta (o problema não é sobre QUAIS PRs formam o
        // lote, é sobre o estado de um PR específico) — reporta como falha
        // real, mesmo tratamento de `lock-blocked` pro exit code.
        outcomes.push({ batch, status: "lock-blocked", detail: `merge falhou (não-lock): ${mergeResult.error}` });
      }
      continue;
    }

    // Vermelho ou timeout — descarta o PR-trem (nunca mergear por engano)
    // e o worktree, bissecta.
    runner.exec("gh", ["pr", "close", String(trainPrNumber)]);
    cleanupIntegrationBranch(runner, branchName, integ.worktreePath, mainCwd);
    const [left, right] = bisectBatch(batch);
    queue.push(left, right);
    outcomes.push({ batch, status: "abandoned", detail: `CI do lote: ${verdict} — bissectando` });
  }

  return outcomes;
}
