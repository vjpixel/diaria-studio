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

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
export function findLiveMergeGrantFile(repoRoot, sessionId, now = Date.now()) {
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
    if (!name.endsWith(".json") || name.startsWith(".") || name.includes("-safeBackup-")) continue;
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
      const found = findLiveMergeGrantFile(repoRoot, sessionId);
      if (!found) return; // no-op silencioso: caso comum, nenhuma concessão pra consumir
      const record = buildConsumedRecord(found, new Date().toISOString());
      writeJsonAtomic(found.path, record);
      // Nunca emitir saída — PostToolUse aqui é side-effect puro, nunca decisão.
    } catch {
      // Fail-open total — ver "FAIL-OPEN TOTAL" no topo do arquivo.
    }
  });
}
