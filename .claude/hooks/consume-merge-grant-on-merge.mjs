// PostToolUse hook — consome AUTOMATICAMENTE uma concessão de janela de merge
// viva (#6296) assim que um comando Bash com `gh pr merge` sai com status 0
// (#6303 fleet review, Finding T; o que isso prova ou não, ver #8793 abaixo).
//
// Wired em .claude/settings.json sob hooks.PostToolUse:
//   matcher "Bash", if "Bash(gh pr merge*)".
//
// ─────────────────────────────────────────────────────────────────────────
// POR QUE ISTO EXISTE
// ─────────────────────────────────────────────────────────────────────────
//
// `grantMergeWindow` (session-registry.ts, #6296) documenta a concessão como
// "uso único" (campo `consumedAt`), mas até este hook NADA no caminho quente
// chamava `session-registry.ts consume-merge-grant` de fato — a única
// "garantia" vivia em prosa nas SKILL.md ("a sessão beneficiada confirma com
// check-merge-grant e chama consume-merge-grant logo após o merge").
//
// O problema real: a sessão beneficiada é tipicamente uma sessão INTERATIVA
// comum, que nunca leu SKILL.md nenhuma — ela só recebeu um `SendMessage`
// pedindo pra esperar a janela (Parte F do #6168). Não há motivo nenhum pra
// ela saber que precisa rodar `consume-merge-grant` depois. Combinado com o
// Finding S (concessão agora escopada por PR — ver `block-gh-pr-merge-
// subagent.mjs`), uma concessão nunca consumida continuava válida pelos 10
// minutos inteiros do TTL — mesmo escopada, ainda era uma janela aberta bem
// maior que o necessário.
//
// Isto contradiz o próprio argumento de desenho central desta issue —
// "o que depende de skill lembrar, não acontece" (ver docblock de
// `session-beacon.mjs`) — bem na peça que mais precisava de mecanismo em vez
// de prosa. Este hook fecha isso: `PostToolUse` roda depois que o comando
// Bash sai com 0 (uma saída não-zero vai pra `PostToolUseFailure`, nunca
// aqui, mesmo padrão documentado em `pr-create-review.mjs` — mas exit 0 do
// comando não prova que o `gh pr merge` sucedeu, ver #8793 abaixo), e se a
// sessão que rodou o comando tem uma
// concessão viva, ela é consumida ali mesmo — nenhuma skill precisa lembrar
// de nada, mesmo argumento que justifica o beacon inteiro.
//
// #8793: "sucesso" aqui é o exit 0 do comando Bash INTEIRO, não do `gh pr
// merge` — `gh pr merge N | tail` sai 0 mesmo com o merge recusado. E o
// filtro `if` do settings era a única coisa que restringia o hook a `gh pr
// merge`. Regra atual (`decideConsumeAfterBash`): consome quando o comando
// tem um `gh pr merge` real E a sessão tem concessão viva candidata — salvo
// quando essa concessão é ESCOPADA ao PR alvo e o GitHub mostra o PR ainda
// aberto sem auto-merge/fila, ou fechado. Concessão genérica (sem `--pr`),
// PR indeterminado ou GitHub inacessível: consome, como antes.
//
// Limitação conhecida: `gh pr merge` SEM número (infere o PR pela branch)
// + pipe com merge recusado ainda consome — sem número não há PR pra
// consultar, e o caminho seguro aqui é fechar a janela (pr-undetermined).
//
// ─────────────────────────────────────────────────────────────────────────
// FAIL-OPEN TOTAL, E POR QUÊ
// ─────────────────────────────────────────────────────────────────────────
//
// Este hook NUNCA emite `hookSpecificOutput` nenhum — não há decisão pra
// tomar em `PostToolUse` aqui (o comando Bash já saiu com status 0), só um efeito colateral
// em disco (marcar `consumedAt`). Qualquer exceção é engolida em silêncio: um
// hook quebrado aqui pode, na pior hipótese, deixar uma concessão sem marcar
// como consumida (ela expira pelo TTL de qualquer forma, 10 min) — nunca pode
// impedir ou alterar o resultado de um `gh pr merge` que já rodou.
//
// No-op silencioso no caso comum: uma coordenadora mergeando normalmente
// nunca teve concessão nenhuma pra consumir — `findLiveMergeGrantFile`
// retorna `null` e o hook não escreve nada.
//
// ─────────────────────────────────────────────────────────────────────────
// SELF-CONTAINED
// ─────────────────────────────────────────────────────────────────────────
//
// Nenhum import de `scripts/*.ts` — mesma razão dos hooks irmãos
// (`pr-create-review.mjs`, `block-gh-pr-merge-subagent.mjs`,
// `session-beacon.mjs`): um import estático de `.ts` quebra o hook inteiro,
// silenciosamente, num Node sem type-stripping nativo. A leitura de
// `merge_grant` é DUPLICADA (não importada) de
// `scripts/lib/session-registry.ts` (`findLiveMergeGrant`/`isMergeGrantLive`)
// e de `.claude/hooks/block-gh-pr-merge-subagent.mjs`
// (`readLiveMergeGrantFor`) — mesmos invariantes (só coordenadora concede,
// nunca a si mesma, uso único, TTL, tolerância de clock skew), mas esta cópia
// PRECISA saber ONDE a concessão mora (o path do arquivo da coordenadora),
// porque ao contrário das duas irmãs ela vai ESCREVER de volta
// (`merge_grant.consumedAt`) — as duas irmãs só respondem "existe uma viva?".
//
// ─────────────────────────────────────────────────────────────────────────
// #8188 — CONSUMIR TAMBÉM PRECISA SABER QUAL PR
// ─────────────────────────────────────────────────────────────────────────
//
// Até o #8188, `findLiveMergeGrantFile` casava só por `grant.grantedTo ===
// sessionId` — nunca comparava `grant.pr` contra a PR que o `gh pr merge`
// que disparou este `PostToolUse` de fato mergeou. Sessão com múltiplas PRs
// em voo (comum no modelo de onda/lote, #6299) que mergeia QUALQUER uma
// delas enquanto segura uma concessão viva pra OUTRA PR tinha essa
// concessão consumida por engano — a PR que ela realmente cobria nunca foi
// tocada, mas a janela morria mesmo assim.
//
// `block-gh-pr-merge-subagent.mjs` já resolvia isso como DIAGNÓSTICO
// (`extractGhPrMergeTargetPr`/`resolveGrantWasConsumed`/`grantCoversTarget`)
// — mostrando que o critério já era conhecido — mas quem de fato ESCREVE
// `consumedAt` (este arquivo) nunca usava o mesmo critério pra decidir SE
// deveria consumir. `extractGhPrMergeTargetPr`/`stripQuotedSpans` abaixo são
// a MESMA implementação duplicada aqui pela mesma razão "self-contained" do
// resto do arquivo (ver bloco acima) — mantidas em paridade manual com as
// de `block-gh-pr-merge-subagent.mjs`, travada por
// `test/session-conflicts-and-merge-grant.test.ts`.
//
// Mesmo critério de `resolveGrantWasConsumed`: uma concessão SEM `pr`
// (retrocompat/genérica) continua consumível por qualquer merge da sessão;
// uma concessão COM `pr` só é consumida quando `targetPr` bate exatamente.
// `targetPr` indeterminado (comando sem número, `gh pr merge` que infere a
// PR pela branch corrente, payload sem `tool_input.command`) preserva o
// comportamento pré-#8188: casa só por sessão, fail-open na direção "ainda
// consome" — não trocar a fricção de over-consumo (mitigada por `--force`)
// pela fricção pior de nunca liberar automaticamente uma concessão genuína
// nesse caso ambíguo.

import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { breakStaleLock, isDeletePendingExhausted, tryAcquireOwnedLock } from "./lib/registry-lock.mjs";
import { appendHookRunLog } from "./lib/hook-run-log.mjs";
import { execFileSync } from "node:child_process";
import { stripQuotedSpans } from "./lib/shell-quote-strip.mjs";

/** Duplicado de `MERGE_GRANT_TTL_MS` — ver session-registry.ts e
 * block-gh-pr-merge-subagent.mjs pro racional (10min: cobre a janela da
 * conversa + o gate de 2 condições que quem recebe ainda vai rodar). */
const MERGE_GRANT_TTL_MS = 10 * 60 * 1000;

/** Duplicado de `CLOCK_SKEW_TOLERANCE_MS` — ver block-gh-pr-merge-subagent.mjs
 * Finding A pro racional completo (relógios não sincronizados entre `Neo` e
 * `300` podem fazer uma concessão genuinamente recente parecer "no
 * futuro"). */
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

/** Só os 3 kinds coordenadores concedem — mesmo conjunto de
 * `COORDINATOR_KINDS` em `block-gh-pr-merge-subagent.mjs`/
 * `session-registry.ts`. */
const COORDINATOR_KINDS = new Set(["overnight", "develop", "continuo"]);

/**
 * Resolve a raiz do checkout PRINCIPAL — nunca a de um worktree vinculado.
 * Mesma implementação/racional dos hooks irmãos: `data/sessions/` mora na
 * junction compartilhada, só visível a partir da raiz principal.
 */
export function resolveMainRepoRoot(execFn = execFileSync) {
  try {
    // windowsHide (#8017, mesma classe do #7952/#7959): via função injetada,
    // invisível ao guard estático que só casa o nome literal do child_process.
    const gitDir = execFn("git", ["rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    return dirname(resolvePath(gitDir));
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  }
}

export function sessionsDir(repoRoot) {
  return join(repoRoot, "data", "sessions");
}

/**
 * Remove o CONTEÚDO de spans entre aspas (simples ou duplas), preservando
 * tudo fora deles — inclusive newlines. Duplicado de
 * `block-gh-pr-merge-subagent.mjs` (`stripQuotedSpans`) pela mesma razão
 * "self-contained" do resto deste arquivo — ver #8188 no topo. Mesmo
 * comportamento: aspa simples sem escape interno, aspa dupla respeita `\"`,
 * aspa não fechada trata o resto da string como dentro do span.
 */
export { stripQuotedSpans };

/** Uma invocação REAL de `gh pr merge`: início da string ou depois de
 * separador (`&&`/`;`/`||`/`|`/newline). Fonte única de
 * `extractGhPrMergeTargetPr` e `isGhPrMergeCommand` (#8793) — mesma
 * expressão de `block-gh-pr-merge-subagent.mjs`, paridade travada por teste. */
const GH_PR_MERGE_INVOCATION_SRC = String.raw`(?:^\s*|(?:&&|;|\|\||\||\n)\s*)gh\s+pr\s+merge\b`;

/**
 * Extrai o número do PR alvo de um comando `gh pr merge` real. `undefined`
 * quando não dá pra determinar (comando sem número — infere a PR pela
 * branch corrente — ou sem `gh pr merge` real nenhum). Duplicado de
 * `block-gh-pr-merge-subagent.mjs` (`extractGhPrMergeTargetPr`) pela mesma
 * razão "self-contained" — ver #8188 no topo.
 */
export function extractGhPrMergeTargetPr(command) {
  if (typeof command !== "string") return undefined;
  const stripped = stripQuotedSpans(command);
  const invocationRe = new RegExp(GH_PR_MERGE_INVOCATION_SRC, "g");
  let end = -1;
  let m;
  while ((m = invocationRe.exec(stripped))) end = m.index + m[0].length;
  if (end === -1) return undefined;
  const segment = /^[^\n;&|]*/.exec(stripped.slice(end))?.[0] ?? "";
  const numMatch = /(?:^|\s)(\d+)(?=\s|$)/.exec(segment);
  if (!numMatch) return undefined;
  const n = Number(numMatch[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * `true` se `command` contém `gh pr merge` como comando REAL (início da
 * string ou depois de separador, fora de aspas). Duplicado de
 * `block-gh-pr-merge-subagent.mjs` (`isGhPrMergeCommand`) pela mesma razão
 * "self-contained" — paridade travada por
 * `test/consume-merge-grant-only-after-real-merge-8793.test.ts`.
 *
 * #8793: até aqui o hook confiava 100% no filtro `if: "Bash(gh pr merge*)"`
 * do `.claude/settings.json` pra só rodar depois de um merge. Se esse filtro
 * não for aplicado (CLI que ignora o campo `if`, matcher alterado, payload
 * de outro comando), `extractGhPrMergeTargetPr` devolve `undefined` também
 * pra comando SEM `gh pr merge` nenhum, e `undefined` casa com qualquer
 * concessão: um `check-merge-grant` ou `merge-lock-acquire` consumia a
 * janela antes do merge. Este é o portão local, independente do settings.
 */
export function isGhPrMergeCommand(command) {
  if (typeof command !== "string") return false;
  return new RegExp(GH_PR_MERGE_INVOCATION_SRC).test(stripQuotedSpans(command));
}

/** Consulta GraphQL do estado de merge (#8793). `gh pr view --json` não expõe
 * `mergeQueueEntry` (medido no gh 2.92: "Unknown JSON field"); `gh api
 * graphql` expõe, e resolve `{owner}`/`{repo}` pelo repositório do cwd. */
const MERGE_STATE_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name)" +
  "{pullRequest(number:$number){state autoMergeRequest{enabledAt} mergeQueueEntry{id}}}}";

/**
 * Orçamento de tempo do `gh` (#8793). O hook tem `timeout: 10` no settings.
 * Pior caso: ~0,5s de startup do Node + resolução da raiz do repo + 2s desta
 * consulta + até 3 tentativas x 2s de lock (`CAS_ATTEMPTS` x
 * `LOCK_TIMEOUT_MS`) = ~8,5s. Estourar os 10s mataria o hook antes de
 * consumir.
 */
const GH_MERGE_STATE_TIMEOUT_MS = 2_000;

/**
 * #8793: estado do merge de `targetPr` segundo o GitHub, em 4 valores:
 *   - `"merged"`      — `state: MERGED`;
 *   - `"auto-queued"` — `OPEN` com `autoMergeRequest` ou `mergeQueueEntry`
 *                       (o `--auto` ou a fila de merge já comprometeram o merge);
 *   - `"not-merged"`  — `OPEN` sem nenhum dos dois, ou `CLOSED`;
 *   - `"unknown"`     — `targetPr` não inteiro, `gh` ausente/offline/timeout,
 *                       resposta ilegível ou sem `pullRequest`.
 *
 * Por que é preciso: `PostToolUse` dispara quando o comando Bash sai com 0,
 * não quando o merge acontece. `gh pr merge 123 --squash 2>&1 | tail -5`
 * sai com o status do `tail` — um merge recusado ("base branch policy
 * prohibits the merge", threads de review não resolvidas) chegava aqui como
 * sucesso, a janela era queimada, e o retry era bloqueado pelo guard do
 * #5716 com "concessão já consumida".
 *
 * `log(level, message, details)` opcional: falha da consulta sai como
 * `warn merge_state_check_failed {pr, code}`. Devolve `{ state, raw }`.
 */
export function resolveMergeState(targetPr, execFn = execFileSync, log = () => {}) {
  if (!Number.isInteger(targetPr)) return { state: "unknown", raw: undefined };
  let pr;
  try {
    const out = execFn(
      "gh",
      [
        "api", "graphql",
        "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${targetPr}`,
        "-f", `query=${MERGE_STATE_QUERY}`,
        "-q", ".data.repository.pullRequest",
      ],
      { encoding: "utf8", timeout: GH_MERGE_STATE_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    pr = JSON.parse(String(out));
  } catch (e) {
    const code = typeof e?.code === "string" && e.code ? e.code : e instanceof SyntaxError ? "JSON_PARSE" : "UNKNOWN";
    log("warn", "merge_state_check_failed", { pr: targetPr, code });
    return { state: "unknown", raw: undefined };
  }
  const raw = pr?.state;
  if (raw === "MERGED") return { state: "merged", raw };
  if (raw === "OPEN" && (pr.autoMergeRequest || pr.mergeQueueEntry)) return { state: "auto-queued", raw };
  if (raw === "OPEN" || raw === "CLOSED") return { state: "not-merged", raw };
  log("warn", "merge_state_check_failed", { pr: targetPr, code: "UNEXPECTED_RESPONSE" });
  return { state: "unknown", raw };
}

/**
 * Decisão do corpo do hook (#8793). Devolve `{ consume, targetPr, reason }`.
 *
 * `findLiveGrant(targetPr)` é OBRIGATÓRIO: devolve a concessão viva
 * candidata (ou `null`), checada em disco ANTES de qualquer rede — a
 * coordenadora mergeando sem concessão nunca paga uma consulta.
 *
 * Não consome (`consume: false`):
 *   - `not-a-merge-command` — o comando não tem `gh pr merge` real (o filtro
 *     `if` do settings deixou de ser o único portão);
 *   - `no-live-grant` — não há concessão viva candidata;
 *   - `merge-not-happened` — concessão ESCOPADA ao PR alvo
 *     (`grant.pr === targetPr`) e estado `not-merged`. Só neste ramo a
 *     janela fica viva — é o retry legítimo depois de um merge recusado, e
 *     o escopo por PR limita o que ela ainda autoriza. Loga
 *     `info merge_grant_kept {pr, state, reason}`.
 *
 * Consome (`consume: true`):
 *   - `pr-undetermined` — `gh pr merge` sem número. Limitação conhecida:
 *     com pipe e merge recusado, ainda consome;
 *   - `generic-grant` — concessão sem `pr` (grant-merge sem `--pr`): segue
 *     consumida como antes, sem consulta — ela autoriza qualquer PR, então
 *     deixá-la viva seria o lado perigoso;
 *   - `merged` — estado `merged`;
 *   - `auto-merge-queued` — estado `auto-queued`;
 *   - `unverified-fail-open` — estado `unknown` (direção pré-#8793).
 */
export function decideConsumeAfterBash(command, { findLiveGrant, execFn = execFileSync, log = () => {} }) {
  if (typeof findLiveGrant !== "function") throw new TypeError("decideConsumeAfterBash: findLiveGrant é obrigatório");
  if (!isGhPrMergeCommand(command)) return { consume: false, targetPr: undefined, reason: "not-a-merge-command" };
  const targetPr = extractGhPrMergeTargetPr(command);
  const grant = findLiveGrant(targetPr);
  if (!grant) return { consume: false, targetPr, reason: "no-live-grant" };
  if (targetPr === undefined) return { consume: true, targetPr, reason: "pr-undetermined" };
  if (grant.pr !== targetPr) return { consume: true, targetPr, reason: "generic-grant" };
  const { state, raw } = resolveMergeState(targetPr, execFn, log);
  if (state === "merged") return { consume: true, targetPr, reason: "merged" };
  if (state === "auto-queued") return { consume: true, targetPr, reason: "auto-merge-queued" };
  if (state === "not-merged") {
    log("info", "merge_grant_kept", { pr: targetPr, state: raw, reason: "merge-not-happened" });
    return { consume: false, targetPr, reason: "merge-not-happened" };
  }
  return { consume: true, targetPr, reason: "unverified-fail-open" };
}

/**
 * Acha, entre os arquivos de sessão COORDENADORA, o que contém uma concessão
 * viva emitida pra `sessionId` — e devolve `{ path, record, grant }` (não só
 * o grant, como as irmãs de leitura) porque este hook precisa saber ONDE
 * escrever `consumedAt` de volta.
 *
 * Mesmos invariantes de `readLiveMergeGrantFor`/`findLiveMergeGrant`: só
 * coordenadora concede, nunca a si mesma, uso único (`consumedAt` já
 * presente = não vale), dentro do TTL com tolerância de clock skew. `null`
 * em qualquer estado onde não dá pra confirmar uma concessão viva — nunca
 * lança.
 *
 * `targetPr` (#8188, opcional/`undefined` por padrão — retrocompat total
 * pra quem chama sem saber o PR): quando informado, uma concessão ESCOPADA
 * a outro PR (`grant.pr !== undefined && grant.pr !== targetPr`) é ignorada
 * — mesmo critério de `resolveGrantWasConsumed` em
 * `block-gh-pr-merge-subagent.mjs`. Concessão sem `pr` (genérica) continua
 * casando com qualquer `targetPr`, inclusive `undefined`.
 */
export function findLiveMergeGrantFile(repoRoot, sessionId, now = Date.now(), includeBackups = false, targetPr = undefined) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const dir = sessionsDir(repoRoot);
  let entries;
  try {
    if (!existsSync(dir)) return null;
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    // #6952: as cópias de conflito do OneDrive entram só quando quem chama
    // pede — ver `consumeGrantUnderLock`. O default segue excluindo, pra não
    // mudar em silêncio o que o resto do arquivo considera "o registro".
    if (!includeBackups && name.includes("-safeBackup-")) continue;
    const path = join(dir, name);
    let record;
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // entrada corrompida/ilegível — ignora só ela, segue as demais
    }
    if (!record || !COORDINATOR_KINDS.has(record.kind)) continue;
    const grant = record.merge_grant;
    if (!grant || grant.grantedTo !== sessionId) continue;
    if (grant.consumedAt) continue; // já consumida — uso único
    if (grant.grantedTo === grant.grantedBy) continue; // auto-concessão nunca vale
    // #8188: concessão escopada a OUTRO PR nunca é a candidata deste merge.
    if (grant.pr !== undefined && targetPr !== undefined && grant.pr !== targetPr) continue;
    const grantedMs = Date.parse(grant.grantedAt);
    if (!Number.isFinite(grantedMs)) continue;
    const ageMs = now - grantedMs;
    if (ageMs < -CLOCK_SKEW_TOLERANCE_MS || ageMs > MERGE_GRANT_TTL_MS) continue;
    return { path, record, grant };
  }
  return null;
}

/**
 * Devolve o record da coordenadora com `merge_grant.consumedAt` marcado —
 * função pura, sem I/O, pra ser testável isoladamente do write real.
 */
export function buildConsumedRecord(found, nowIso) {
  return { ...found.record, merge_grant: { ...found.grant, consumedAt: nowIso } };
}

/** Write atômico (write-then-rename) — mesmo padrão de `session-beacon.mjs`. */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, path);
}

// ───────────────────────────────────────────────────────────────────────────
// #6952 — este hook é o TERCEIRO escritor do registro de sessão
// ───────────────────────────────────────────────────────────────────────────
//
// O #6952 fechou o lost update em `scripts/lib/session-registry.ts` e em
// `session-beacon.mjs`, serializando os dois sobre `{path}.lock`. Este arquivo
// tinha ficado de fora — e ele é justamente quem grava `merge_grant.consumedAt`
// no caminho quente de produção (o `consume-merge-grant` do CLI quase nunca é
// chamado de fato; ver "POR QUE ISTO EXISTE" no topo).
//
// Sem participar do lock, ele continua fazendo read-modify-write solto:
// `findLiveMergeGrantFile` lê o record, e o `writeJsonAtomic` grava
// `{...found.record, merge_grant:{...consumedAt}}` depois — apagando qualquer
// coisa que o beacon ou a skill tenham gravado nesse meio (um `claimed_issues`
// novo, um `touched_paths`). Dois escritores serializados e um terceiro solto
// não é exclusão mútua: é o mesmo bug com uma testemunha a menos.
//
// Pior: o que este hook perde é o `consumedAt`. Perdê-lo deixa uma concessão
// JÁ USADA viva pelo resto do TTL — uso duplo, que é o dano que o #6952
// classifica como pior que a perda.
//
// Orçamento de bloqueio pequeno pelo mesmo motivo do beacon: isto é um
// PostToolUse que roda logo depois de um comando Bash com `gh pr merge` que
// saiu com status 0, e não
// pode segurar o editor. Fail-open igual ao resto do arquivo.

// #9203: `breakStaleLock`/`tryAcquireOwnedLock` vêm de ./lib/registry-lock.mjs
// — mesma política de `scripts/lib/session-registry.ts` (dono vivo nunca é
// quebrado por idade; releitura sob `.steal` antes do unlink).
const LOCK_TIMEOUT_MS = 2_000;
const CAS_ATTEMPTS = 3;

/**
 * Marca a concessão viva de `sessionId` como consumida, sob o MESMO
 * `{path}.lock` que os outros dois escritores usam, relendo o record fresco
 * DENTRO do lock (nunca o snapshot que `findLiveMergeGrantFile` leu antes).
 *
 * Devolve `true` se gravou. `false` cobre tanto "não havia concessão viva"
 * quanto "não consegui gravar" — este hook é fail-open total e não tem canal
 * de saída (PostToolUse é side-effect puro), então a distinção não teria onde
 * aparecer; quem precisa dela é o CLI, não aqui.
 *
 * `targetPr` (#8188): repassado a `findLiveMergeGrantFile` — só concessões
 * escopadas a ESTE PR (ou sem escopo de PR nenhum) são candidatas. Sem isto,
 * o loop abaixo consumia INDISCRIMINADAMENTE toda concessão viva da sessão
 * em `data/sessions/` a cada merge — inclusive a de um PR completamente
 * diferente que a mesma sessão também tinha em voo (cenário de onda/lote,
 * #6299) — porque cada iteração faz uma busca nova, sem lembrar QUAL PR
 * disparou o hook.
 */
export function consumeGrantUnderLock(
  repoRoot,
  sessionId,
  nowIso = new Date().toISOString(),
  // Só pra teste: o caso "lock retido é respeitado" precisa esperar o
  // orçamento estourar, e os 3×2s de produção custavam 6s de wall-clock na
  // suíte — o bastante, somado aos outros testes de lock, pra estourar o
  // orçamento de 300s do batch do runner paralelo. Produção nunca passa isto.
  attempts = CAS_ATTEMPTS,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  targetPr = undefined,
  // @internal Seam de teste (#9280): `acquire` substitui `tryAcquireOwnedLock`.
  opts = {},
) {
  // #6952 (achado do review independente): varre o GRUPO inteiro — arquivo
  // real E cópias `-safeBackup-*`. Desde que `mergeSessionRecords` passou a
  // UNIR o `merge_grant`, uma concessão que vive só numa cópia de conflito é
  // ENCONTRADA por `findLiveMergeGrant`; se este hook (que é quem consome no
  // caminho quente) continuasse cego a backup, essa concessão seria
  // encontrável e inconsumível — viva o TTL inteiro. Consumir de mais nunca é
  // o lado perigoso: fecha janela, não abre.
  let consumedAny = false;
  for (;;) {
    const initial = findLiveMergeGrantFile(repoRoot, sessionId, Date.now(), true, targetPr);
    if (!initial) return consumedAny;
    if (!consumeOneUnderLock(initial, nowIso, attempts, lockTimeoutMs, repoRoot, opts)) return consumedAny;
    consumedAny = true;
  }
}

/** Marca `consumedAt` num único arquivo do grupo, sob o lock dele. */
function consumeOneUnderLock(initial, nowIso, attempts = CAS_ATTEMPTS, lockTimeoutMs = LOCK_TIMEOUT_MS, repoRoot = undefined, opts = {}) {
  const lockPath = `${initial.path}.lock`;
  const acquire = opts.acquire ?? tryAcquireOwnedLock;
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    let acquired = false;
    try {
      breakStaleLock(lockPath);
      const deadline = Date.now() + lockTimeoutMs;
      for (;;) {
        if (acquire(lockPath)) { acquired = true; break; }
        if (Date.now() >= deadline) throw Object.assign(new Error(`lock timeout: ${lockPath}`), { code: "LOCK_TIMEOUT" });
        // Espera 50ms DORMINDO, não em busy wait (#6952/#6969, #7031).
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }

      // Relê ESTE arquivo dentro do lock — nunca o snapshot de fora, e nunca
      // uma busca global nova (que poderia cair noutro arquivo do grupo e
      // gravar no lugar errado, com o lock do arquivo errado na mão).
      const record = JSON.parse(readFileSync(initial.path, "utf8"));
      const grant = record?.merge_grant;
      // Sumiu, virou outra concessão, ou já foi consumida por outro caminho
      // entre a busca e o lock: nada a fazer, e forçar ressuscitaria o velho.
      if (
        !grant ||
        grant.grantedTo !== initial.grant.grantedTo ||
        grant.grantedBy !== initial.grant.grantedBy ||
        grant.grantedAt !== initial.grant.grantedAt ||
        grant.consumedAt
      ) {
        return false;
      }

      writeJsonAtomic(initial.path, buildConsumedRecord({ record, grant }, nowIso));

      const onDisk = JSON.parse(readFileSync(initial.path, "utf8"));
      if (onDisk?.merge_grant?.consumedAt !== nowIso) {
        throw Object.assign(new Error("CAS verify failed: outro escritor sobrescreveu o consumedAt"), { code: "CAS_VERIFY_FAILED" });
      }
      return true;
    } catch (e) {
      // Retry: contenção de lock, ou verify perdido pro caminho advisory
      // cross-máquina do OneDrive (#6182). O rastro sai UMA vez, depois do laço.
      lastErr = e;
    } finally {
      if (acquired) { try { unlinkSync(lockPath); } catch { /* ignore */ } }
    }
  }
  // #9280: esgotou as tentativas — o grant fica sem consumir até o TTL. Deixa
  // rastro (stderr + data/run-log.jsonl) pra QUALQUER causa, classificada.
  logGrantNotConsumed(repoRoot, lastErr, initial.path, attempts);
  return false;
}

/**
 * Classe estável da falha que impediu o consumo (#9280). Lê só propriedades
 * estruturadas (`code`, marcador de delete-pending), nunca a mensagem.
 */
export function classifyConsumeError(e) {
  if (isDeletePendingExhausted(e)) return "DELETE_PENDING_EXHAUSTED";
  if (typeof e?.code === "string" && e.code) return e.code;
  if (e instanceof SyntaxError) return "JSON_PARSE";
  return "UNKNOWN";
}

/** Aviso único de grant não consumido: stderr + run-log, sem conteúdo do registro (#9280). */
export function logGrantNotConsumed(repoRoot, err, path, attempts, deps = {}) {
  const code = classifyConsumeError(err);
  const file = basename(path);
  try {
    process.stderr.write(`[consume-merge-grant] concessão não consumida em ${file} após ${attempts} tentativas (${code})\n`);
  } catch { /* ignore */ }
  appendHookRunLog(repoRoot, "consume-merge-grant", "warn", "merge_grant_not_consumed", { code, file, attempts }, deps);
}

// #2019-style CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por test/session-conflicts-and-merge-grant.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  // #9214: path com espaço/não-ASCII chega percent-encoded em import.meta.url
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) ||
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      const sessionId = payload.session_id;
      if (!sessionId) return; // sem identidade não há concessão pra procurar
      const repoRoot = resolveMainRepoRoot();
      // #8793: só consome depois de um `gh pr merge` REAL (nunca de um
      // `check-merge-grant`/`merge-lock-acquire` que chegue aqui por falha
      // do filtro `if` do settings) e sem evidência de que o merge falhou
      // (pipe pro `tail` mascarando o exit code). `targetPr` (#8188) é o PR
      // que este `gh pr merge` mergeou — `undefined` quando o comando não
      // traz número, preservando o comportamento pré-#8188 nesse caso (ver
      // docblock de `consumeGrantUnderLock`).
      const decision = decideConsumeAfterBash(payload.tool_input?.command, {
        findLiveGrant: (pr) => findLiveMergeGrantFile(repoRoot, sessionId, Date.now(), true, pr)?.grant ?? null,
        log: (level, message, details) => appendHookRunLog(repoRoot, "consume-merge-grant", level, message, details),
      });
      if (!decision.consume) return;
      const targetPr = decision.targetPr;
      // #6952: sob o lock compartilhado, relendo fresco lá dentro — nunca o
      // read-modify-write solto que apagava a escrita concorrente do beacon.
      consumeGrantUnderLock(repoRoot, sessionId, new Date().toISOString(), CAS_ATTEMPTS, LOCK_TIMEOUT_MS, targetPr);
      // Nunca emitir saída — PostToolUse aqui é side-effect puro, nunca decisão.
    } catch {
      // Fail-open total — ver "FAIL-OPEN TOTAL" no topo do arquivo.
    }
  });
}
