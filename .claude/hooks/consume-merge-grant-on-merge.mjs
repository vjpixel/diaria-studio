// PostToolUse hook — consome AUTOMATICAMENTE uma concessão de janela de merge
// viva (#6296) assim que `gh pr merge` SUCEDE (#6303 fleet review, Finding T).
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
// de prosa. Este hook fecha isso: `PostToolUse` roda depois que `gh pr merge`
// SUCEDE (o próprio harness só dispara este evento em sucesso — uma falha
// vai pra `PostToolUseFailure`, nunca aqui, mesmo padrão documentado em
// `pr-create-review.mjs`), e se a sessão que rodou o comando tem uma
// concessão viva, ela é consumida ali mesmo — nenhuma skill precisa lembrar
// de nada, mesmo argumento que justifica o beacon inteiro.
//
// ─────────────────────────────────────────────────────────────────────────
// FAIL-OPEN TOTAL, E POR QUÊ
// ─────────────────────────────────────────────────────────────────────────
//
// Este hook NUNCA emite `hookSpecificOutput` nenhum — não há decisão pra
// tomar em `PostToolUse` aqui (o merge já aconteceu), só um efeito colateral
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

import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/** Duplicado de `MERGE_GRANT_TTL_MS` — ver session-registry.ts e
 * block-gh-pr-merge-subagent.mjs pro racional (10min: cobre a janela da
 * conversa + o gate de 2 condições que quem recebe ainda vai rodar). */
const MERGE_GRANT_TTL_MS = 10 * 60 * 1000;

/** Duplicado de `CLOCK_SKEW_TOLERANCE_MS` — ver block-gh-pr-merge-subagent.mjs
 * Finding A pro racional completo (relógios não sincronizados entre `Neo` e
 * `helios` podem fazer uma concessão genuinamente recente parecer "no
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
    const gitDir = execFn("git", ["rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 10_000,
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
 */
export function findLiveMergeGrantFile(repoRoot, sessionId, now = Date.now(), includeBackups = false) {
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
// PostToolUse que roda logo depois de um `gh pr merge` bem-sucedido, e não
// pode segurar o editor. Fail-open igual ao resto do arquivo.

const STALE_LOCK_MS = 60_000;
const LOCK_TIMEOUT_MS = 2_000;
const CAS_ATTEMPTS = 3;

/** Remove um `.lock` órfão (processo morto segurando). Nunca lança. */
function breakStaleLock(lockPath) {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs < STALE_LOCK_MS) return;
    unlinkSync(lockPath);
  } catch { /* inexistente, ou outro quebrador ganhou — segue */ }
}

/**
 * Marca a concessão viva de `sessionId` como consumida, sob o MESMO
 * `{path}.lock` que os outros dois escritores usam, relendo o record fresco
 * DENTRO do lock (nunca o snapshot que `findLiveMergeGrantFile` leu antes).
 *
 * Devolve `true` se gravou. `false` cobre tanto "não havia concessão viva"
 * quanto "não consegui gravar" — este hook é fail-open total e não tem canal
 * de saída (PostToolUse é side-effect puro), então a distinção não teria onde
 * aparecer; quem precisa dela é o CLI, não aqui.
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
    const initial = findLiveMergeGrantFile(repoRoot, sessionId, Date.now(), true);
    if (!initial) return consumedAny;
    if (!consumeOneUnderLock(initial, nowIso, attempts, lockTimeoutMs)) return consumedAny;
    consumedAny = true;
  }
}

/** Marca `consumedAt` num único arquivo do grupo, sob o lock dele. */
function consumeOneUnderLock(initial, nowIso, attempts = CAS_ATTEMPTS, lockTimeoutMs = LOCK_TIMEOUT_MS) {
  const lockPath = `${initial.path}.lock`;

  for (let i = 0; i < attempts; i++) {
    let acquired = false;
    try {
      breakStaleLock(lockPath);
      const deadline = Date.now() + lockTimeoutMs;
      for (;;) {
        try { closeSync(openSync(lockPath, "wx")); acquired = true; break; } catch (e) {
          if (e?.code !== "EEXIST") throw e;
          if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockPath}`);
          // Espera 50ms DORMINDO, não em busy wait — mesmo padrão de
          // `acquireLock` em `scripts/lib/file-lock.ts` (#6952/#6969): o spin
          // busy-wait competia por CPU justamente com o dono do lock enquanto
          // ele precisava de CPU pra soltá-lo. `Atomics.wait` é síncrono e é
          // a espera dormindo real disponível aqui — reintroduzido por
          // engano neste hook no #7031, corrigido de volta.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
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
        throw new Error("CAS verify failed: outro escritor sobrescreveu o consumedAt");
      }
      return true;
    } catch {
      // Retry: contenção de lock, ou verify perdido pro caminho advisory
      // cross-máquina do OneDrive (#6182).
    } finally {
      if (acquired) { try { unlinkSync(lockPath); } catch { /* ignore */ } }
    }
  }
  return false;
}

// #2019-style CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por test/session-conflicts-and-merge-grant.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      const sessionId = payload.session_id;
      if (!sessionId) return; // sem identidade não há concessão pra procurar
      const repoRoot = resolveMainRepoRoot();
      // #6952: sob o lock compartilhado, relendo fresco lá dentro — nunca o
      // read-modify-write solto que apagava a escrita concorrente do beacon.
      consumeGrantUnderLock(repoRoot, sessionId);
      // Nunca emitir saída — PostToolUse aqui é side-effect puro, nunca decisão.
    } catch {
      // Fail-open total — ver "FAIL-OPEN TOTAL" no topo do arquivo.
    }
  });
}
