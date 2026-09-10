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
// (`data/sessions/*.json` → `worktree_claim.path`) por um `session_id`
// diferente do que está commitando, ou quando o branch atual do HEAD não
// bate com o que `git worktree list --porcelain` reporta para este path.
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
// Self-contained (nenhum import de `scripts/*.ts`) — mesma razão documentada
// nos hooks irmãos: import estático de `.ts` quebra o hook inteiro, em
// silêncio, num Node sem type-stripping nativo.
//
// Fail-open sempre: um hook quebrado, ou estado ambíguo (sem `session_id`
// no payload, `data/sessions/` ausente, JSON corrompido), nunca deve travar
// um `git commit` legítimo.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
 * Varre `data/sessions/*.json` procurando um `worktree_claim.path` (formato
 * gravado por `session-registry.ts` `claimWorktree`, campo top-level
 * `session_id`) que aponte para ESTE worktree (`checkoutRoot`) mas
 * pertença a um `session_id` DIFERENTE do que está tentando commitar.
 * Devolve o `session_id` reivindicante, ou `null` (sem conflito, ou estado
 * ambíguo — fail-open).
 */
export function findConflictingClaimSessionId(repoRoot, checkoutRoot, callerSessionId, now = Date.now()) {
  const dir = sessionsDir(repoRoot);
  let entries;
  try {
    if (!existsSync(dir)) return null;
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const wantedPath = resolvePath(checkoutRoot);
  for (const entry of entries) {
    if (!entry.isFile?.() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    let record;
    try {
      record = JSON.parse(readFileSync(join(dir, entry.name), "utf8"));
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const claim = record.worktree_claim;
    if (!claim || typeof claim.path !== "string" || claim.path === "") continue;
    if (resolvePath(claim.path) !== wantedPath) continue;
    const expiresAt = claim.expires_at ?? claim.expiresAt;
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= now) continue; // claim expirado
    const recordSessionId = record.session_id ?? record.sessionId ?? claim.sessionId;
    if (typeof recordSessionId !== "string" || recordSessionId === "") continue;
    if (typeof callerSessionId === "string" && callerSessionId !== "" && recordSessionId === callerSessionId) continue; // é a própria sessão
    return recordSessionId;
  }
  return null;
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

/** Branch que `git worktree list --porcelain` reporta para `checkoutRoot`
 * (parser do formato porcelain: blocos `worktree <path>` / `branch
 * refs/heads/<nome>` / `HEAD ...`, separados por linha em branco). `null`
 * quando não encontra o worktree na lista ou em erro. */
export function getWorktreeListedBranch(checkoutRoot, gitOutput) {
  const wantedPath = resolvePath(checkoutRoot);
  const lines = gitOutput.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("worktree ")) continue;
    const wtPath = lines[i].slice("worktree ".length).trim();
    if (resolvePath(wtPath) !== wantedPath) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith("branch ")) {
        return lines[j].slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      }
      if (lines[j].startsWith("worktree ") || lines[j] === "") break;
    }
    return null; // worktree achado, sem linha `branch` (detached)
  }
  return null;
}

export const BLOCK_REASON_CLAIM =
  "`git commit` bloqueado pelo guard mecânico #7722 item 4: este worktree tem um claim ativo " +
  "(`data/sessions/*.json` → `worktree_claim.path`) de uma sessão DIFERENTE da que está tentando " +
  "commitar agora. Provável cenário: outra sessão adotou/mexeu neste worktree e trocou a branch por " +
  "baixo — commitar aqui pode ir parar num branch/PR que não é o seu. Confirme com " +
  "`npx tsx scripts/lib/session-registry.ts is-claimed` (ou releia `data/sessions/`) antes de prosseguir.";

export const BLOCK_REASON_BRANCH_DIVERGE =
  "`git commit` bloqueado pelo guard mecânico #7722 item 4: a branch do HEAD deste worktree diverge " +
  "da branch que `git worktree list` registra para este path — sinal de que outra sessão trocou a " +
  "branch por baixo deste worktree entre o dispatch e agora. Confirme com `git status`/`git branch` " +
  "antes de commitar.";

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

      const hookDir = dirname(fileURLToPath(import.meta.url));
      const checkoutRoot = join(hookDir, "..", "..");
      if (!isLinkedWorktree(checkoutRoot)) return; // fora de escopo: só worktree (mesmo escopo de block-worktree-bare-push.mjs)

      // git-common-dir (repo root para data/sessions) — cada worktree tem seu
      // próprio checkoutRoot, mas data/sessions/ vive só no checkout principal.
      let repoRoot = checkoutRoot;
      try {
        const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: checkoutRoot,
          encoding: "utf8",
          timeout: 1000,
        }).trim();
        if (commonDir) repoRoot = resolvePath(join(checkoutRoot, commonDir, ".."));
      } catch {
        // fail-open: usa checkoutRoot mesmo
      }

      const callerSessionId = payload.session_id;
      const conflictingSessionId = findConflictingClaimSessionId(repoRoot, checkoutRoot, callerSessionId);
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

      const branchNow = getHeadBranch(checkoutRoot);
      if (branchNow) {
        try {
          const gitOutput = execFileSync("git", ["worktree", "list", "--porcelain"], {
            cwd: checkoutRoot,
            encoding: "utf8",
            timeout: 1000,
          }).trim();
          const listedBranch = getWorktreeListedBranch(checkoutRoot, gitOutput);
          if (listedBranch && listedBranch !== branchNow) {
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
        } catch {
          // fail-open: sem `git worktree list` não dá pra comparar
        }
      }
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar `git commit` legítimo.
    }
  });
}
