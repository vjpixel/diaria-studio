// PreToolUse hook — recusa `git commit` quando a sessão que está commitando
// não é a dona do claim de worktree para este diretório, ou quando a branch
// do HEAD diverge do que `git worktree list` reporta para este path (#7722
// item 4, "corrigindo #7806 stub que sempre retornava blocked:false").
//
// Cenário: outra sessão adota/mexe num worktree que não é dela e troca a
// branch por baixo (`git checkout master` no meio de um worktree que tinha
// `fix/7707-...` checked out) — a sessão DONA do worktree, sem saber disso,
// segue trabalhando e commita ali. Este guard barra o `git commit` quando
// há evidência de que outra sessão reivindicou este mesmo worktree path
// (`data/sessions/.worktree-claims/<hash>.json`, #7892/#7903 — arquivo
// autoritativo indexado por path, não o mirror) por um `session_id`
// diferente do que está commitando, ou quando o branch atual do HEAD não
// bate com o `branch` gravado nesse mesmo claim no momento em que foi feito.
//
// #7895 (achado da Fase 1.5, rodada overnight 260909-260910): a versão
// entregue no #7810 nunca lia o payload `PreToolUse` — rodava sua lógica
// incondicionalmente em CADA invocação (spawn de `git` a cada chamada),
// independente de o comando ser ou não `git commit`, e nunca foi registrada
// em `.claude/settings.json`. Corrigido aqui: só roda quando o `Bash`
// invocado contém de fato um `git commit` (detecção por token, mesma
// convenção dos hooks irmãos), e só emite output quando bloqueia — mesmo
// protocolo JSON (`hookSpecificOutput.permissionDecision: "deny"`) que
// `block-worktree-bare-push.mjs`/`block-branch-checkout-main.mjs` usam,
// substituindo o `process.exit(1)`/`console.error` da versão anterior, que
// não é o contrato que o harness lê para bloquear um `PreToolUse`.
//
// #7903 (achado do review consolidado diário, PR #7899): a versão acima
// tinha 2 defeitos que a deixavam praticamente inerte. (1) A checagem de
// claim lia só o MIRROR (`data/sessions/*.json` → `worktree_claim`), nunca
// o arquivo indexado por path (`data/sessions/.worktree-claims/<hash>.json`)
// que o #7892 tornou a fonte de verdade — o mirror é last-writer-wins POR
// SESSÃO (uma sessão que reivindica vários worktrees sobrescreve o próprio
// mirror a cada claim novo), então uma claim antiga continuava viva no
// arquivo autoritativo sem o mirror refletir isso: falso-negativo. Corrigido
// lendo `worktreeClaimFilePath` diretamente (cópia self-contained da mesma
// chave de `session-registry.ts`). (2) `BLOCK_REASON_BRANCH_DIVERGE` nunca
// disparava — comparava `git rev-parse --abbrev-ref HEAD` deste worktree com
// a branch que `git worktree list --porcelain` reporta PARA O MESMO path:
// as duas vêm do mesmo HEAD, então são sempre iguais por construção, código
// morto que parecia proteção. Corrigido comparando contra o `branch`
// gravado NO MOMENTO DO CLAIM (`claimWorktree` ganhou esse parâmetro) — só
// isso detecta de fato uma troca de branch por baixo depois do claim.
//
// Self-contained (nenhum import de `scripts/*.ts`) — mesma razão documentada
// nos hooks irmãos: import estático de `.ts` quebra o hook inteiro, em
// silêncio, num Node sem type-stripping nativo.
//
// Fail-open sempre: um hook quebrado, ou estado ambíguo (sem `session_id`
// no payload, `data/sessions/` ausente, JSON corrompido), nunca deve travar
// um `git commit` legítimo.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Remove o CONTEÚDO de spans entre aspas (simples ou duplas), preservando
 * tudo fora deles. Duplicado dos hooks irmãos (self-contained).
 */
export function stripQuotedSpans(command) {
  let result = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < n && command[j] !== "'") j++;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

const SEPARATOR_RE = /(?:&&|;|\|\||\||\n)/;

function commandSegments(command) {
  if (typeof command !== "string") return [];
  const stripped = stripQuotedSpans(command);
  return stripped
    .split(SEPARATOR_RE)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/** `true` quando `tokens` é um segmento `git commit` real (token exato, não
 * substring de outro subcomando como `git commit-graph`). */
export function isGitCommitCommand(tokens) {
  if (tokens[0]?.toLowerCase() !== "git") return false;
  return tokens[1]?.toLowerCase() === "commit";
}

/** `true` se `command` contém algum `git commit` como comando real. */
export function commandHasGitCommit(command) {
  return commandSegments(command).some(isGitCommitCommand);
}

/** Duplicado de `isLinkedWorktree` dos hooks irmãos. */
function statIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isLinkedWorktree(startDir) {
  try {
    const gitPath = join(startDir, ".git");
    if (!existsSync(gitPath)) return false;
    return !statIsDirectory(gitPath);
  } catch {
    return false;
  }
}

export function sessionsDir(repoRoot) {
  return join(repoRoot, "data", "sessions");
}

/**
 * Cópia self-contained de `worktreeClaimKey`/`worktreeClaimFilePath`
 * (`scripts/lib/session-registry.ts`, #7892) — a chave do arquivo
 * autoritativo de claim é um hash estável do path normalizado. Duplicado
 * (não importado) pela mesma razão documentada no topo do arquivo: hooks
 * self-contained não importam `.ts`.
 */
function worktreeClaimKey(path) {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

function worktreeClaimFilePath(repoRoot, path) {
  return join(repoRoot, "data", "sessions", ".worktree-claims", `${worktreeClaimKey(path)}.json`);
}

/**
 * Lê o registro autoritativo de claim (`data/sessions/.worktree-claims/
 * <hash>.json`, gravado por `session-registry.ts` `claimWorktree`) para
 * `checkoutRoot`. Devolve o record parseado (`{ path, sessionId, branch,
 * claimed_at, expires_at }`) quando o arquivo existe e está vivo (`now` <
 * `expires_at`), ou `null` — arquivo ausente, malformado, ou claim expirada
 * (fail-open em todos os casos ambíguos).
 *
 * **#7903**: substitui a varredura de `data/sessions/*.json` (mirror) que
 * este hook usava antes — o mirror é last-writer-wins POR SESSÃO (uma
 * sessão que reivindica vários worktrees em sequência sobrescreve o próprio
 * mirror a cada claim novo), então uma claim antiga podia seguir viva no
 * arquivo autoritativo sem o mirror refletir isso. O arquivo indexado por
 * path é a fonte de verdade desde o #7892; ler só ele fecha esse
 * falso-negativo.
 */
export function readWorktreeClaimRecord(repoRoot, checkoutRoot, now = Date.now()) {
  const claimFile = worktreeClaimFilePath(repoRoot, resolvePath(checkoutRoot));
  let record;
  try {
    if (!existsSync(claimFile)) return null;
    record = JSON.parse(readFileSync(claimFile, "utf8"));
  } catch {
    return null;
  }
  if (!record || typeof record !== "object") return null;
  const expiresAt = record.expires_at ?? record.expiresAt;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= now) return null; // claim expirada
  return record;
}

/**
 * `session_id` de quem reivindica um worktree via `record` (já lido —
 * `readWorktreeClaimRecord`), quando é uma sessão DIFERENTE de
 * `callerSessionId`. `null` — sem claim viva, claim é da própria sessão, ou
 * estado ambíguo (fail-open). Variante que não faz I/O — usada pelo caminho
 * de runtime (que já leu `record` uma vez pra reusar no check de branch
 * também); `findConflictingClaimSessionId` abaixo é o wrapper que lê +
 * checa numa chamada só, mantido para os chamadores/testes existentes.
 */
export function findConflictingClaimSessionIdFromRecord(record, callerSessionId) {
  // Self-review (#7899 finding 8): sem `callerSessionId` não dá pra distinguir
  // "é a própria sessão" de "é outra sessão" — nunca sinalizar conflito nesse
  // estado (fail-open), senão o claim da PRÓPRIA sessão (bem provável de
  // existir, dado que o convencional é reivindicar o worktree antes de
  // trabalhar nele) seria lido como alheio.
  if (typeof callerSessionId !== "string" || callerSessionId === "") return null;
  if (!record) return null;
  // Mesma cadeia de fallback de `session-registry.ts` (`claimWorktree`:
  // `other.session_id ?? other.id ?? other.sessionId`) — um record que só
  // carrega `id` não pode ser silenciosamente pulado (falso-negativo,
  // #7899 finding 7, preservado na migração pro arquivo autoritativo).
  const recordSessionId = record.session_id ?? record.id ?? record.sessionId;
  if (typeof recordSessionId !== "string" || recordSessionId === "") return null;
  if (recordSessionId === callerSessionId) return null; // é a própria sessão
  return recordSessionId;
}

/**
 * `session_id` de quem reivindica `checkoutRoot` HOJE via o registro
 * autoritativo (`readWorktreeClaimRecord`), quando é uma sessão DIFERENTE
 * de `callerSessionId`. `null` — sem claim viva, claim é da própria sessão,
 * ou estado ambíguo (fail-open). Lê + checa numa chamada só; ver
 * `findConflictingClaimSessionIdFromRecord` para a variante sem I/O.
 */
export function findConflictingClaimSessionId(repoRoot, checkoutRoot, callerSessionId, now = Date.now()) {
  const record = readWorktreeClaimRecord(repoRoot, checkoutRoot, now);
  return findConflictingClaimSessionIdFromRecord(record, callerSessionId);
}

/** Branch do HEAD atual do worktree (`cwd: checkoutRoot`), `null` em erro
 * ou detached HEAD. */
export function getHeadBranch(checkoutRoot) {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: checkoutRoot,
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

export const BLOCK_REASON_CLAIM =
  "`git commit` bloqueado pelo guard mecânico #7722 item 4: este worktree tem um claim ativo " +
  "(`data/sessions/.worktree-claims/<hash>.json`, #7892) de uma sessão DIFERENTE da que está tentando " +
  "commitar agora. Provável cenário: outra sessão adotou/mexeu neste worktree e trocou a branch por " +
  "baixo — commitar aqui pode ir parar num branch/PR que não é o seu. Releia os registros em " +
  "`data/sessions/.worktree-claims/` pra identificar a sessão reivindicante " +
  "antes de prosseguir — `session-registry.ts is-claimed` é sobre claims de ISSUE, não de worktree, " +
  "não serve pra confirmar este caso (#7899 finding 4).";

export const BLOCK_REASON_BRANCH_DIVERGE =
  "`git commit` bloqueado pelo guard mecânico #7722 item 4 (#7903): a branch do HEAD deste worktree " +
  "diverge da branch registrada NO MOMENTO DO CLAIM (`data/sessions/.worktree-claims/<hash>.json` → " +
  "`branch`) — sinal de que a branch foi trocada por baixo deste worktree entre o claim e agora. " +
  "Confirme com `git status`/`git branch` antes de commitar.";

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      if (payload.tool_name && payload.tool_name !== "Bash") return;
      const command = payload.tool_input?.command;
      if (!commandHasGitCommit(command)) return;

      // Self-review (#7899 finding 1): NUNCA derivar o cwd real da chamada a
      // partir de `import.meta.url`/`dirname` do ARQUIVO deste hook — medição
      // ao vivo documentada em `block-gh-pr-merge-subagent.mjs` (#7712)
      // mostrou que, para uma sessão spawnada com `isolation: "worktree"`, o
      // harness carrega o hook a partir de `${CLAUDE_PROJECT_DIR}`, que fica
      // FIXO na raiz da sessão original — não acompanha o worktree. Só
      // `payload.cwd` reflete o cwd de fato da chamada `Bash` que disparou
      // este hook. Fallback pro path do próprio arquivo só quando `cwd`
      // vem ausente do payload (nunca deveria acontecer em uso real, mas
      // mantém o hook testável/funcional fora do harness).
      const payloadCwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : null;
      const probeCwd = payloadCwd ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
      // `payload.cwd` pode ser uma SUBPASTA do worktree (a sessão pode ter
      // dado `cd` antes do `git commit`), não necessariamente a raiz — usa
      // `git rev-parse --show-toplevel` pra resolver a raiz de verdade, que
      // é o que `worktree_claim.path`/`isLinkedWorktree` (checagem de
      // `.git` DIRETO sob o path) esperam.
      let checkoutRoot = probeCwd;
      try {
        const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: probeCwd,
          encoding: "utf8",
          timeout: 1000,
        }).trim();
        if (toplevel) checkoutRoot = toplevel;
      } catch {
        // fail-open: usa probeCwd mesmo (pode não ser a raiz exata do worktree)
      }
      if (!isLinkedWorktree(checkoutRoot)) return; // fora de escopo: só worktree (mesmo escopo de block-worktree-bare-push.mjs)

      // git-common-dir (repo root para data/sessions) — cada worktree tem seu
      // próprio checkoutRoot, mas data/sessions/ vive só no checkout principal.
      // Self-review (#7899 finding 2): `git rev-parse --git-common-dir`
      // devolve um path ABSOLUTO — `resolvePath(commonDir, "..")` re-raiza
      // corretamente nele; `join(checkoutRoot, commonDir, "..")` (bug
      // anterior) faz concatenação de string e produz um path inexistente
      // quando `commonDir` já é absoluto (reproduzido ao vivo neste worktree).
      let repoRoot = checkoutRoot;
      try {
        const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: checkoutRoot,
          encoding: "utf8",
          timeout: 1000,
        }).trim();
        if (commonDir) repoRoot = resolvePath(commonDir, "..");
      } catch {
        // fail-open: usa checkoutRoot mesmo
      }

      const callerSessionId = payload.session_id;
      // Lido uma vez, reusado pelos dois checks abaixo (claim conflitante +
      // divergência de branch) — evita 2 leituras do mesmo arquivo.
      const claimRecord = readWorktreeClaimRecord(repoRoot, checkoutRoot);
      const conflictingSessionId = findConflictingClaimSessionIdFromRecord(claimRecord, callerSessionId);
      if (conflictingSessionId) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: BLOCK_REASON_CLAIM,
            },
          }),
        );
        return;
      }

      // #7903: compara contra a branch gravada NO MOMENTO DO CLAIM (não
      // mais contra `git worktree list --porcelain` — ambos os dois lados
      // dessa comparação vinham do MESMO HEAD deste worktree, então nunca
      // podiam divergir por construção, código morto que parecia proteção).
      const claimedBranch = typeof claimRecord?.branch === "string" ? claimRecord.branch : null;
      if (claimedBranch) {
        const branchNow = getHeadBranch(checkoutRoot);
        if (branchNow && branchNow !== claimedBranch) {
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: BLOCK_REASON_BRANCH_DIVERGE,
              },
            }),
          );
        }
      }
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar `git commit` legítimo.
    }
  });
}
