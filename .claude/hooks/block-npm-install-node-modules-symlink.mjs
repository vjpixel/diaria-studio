// PreToolUse hook (#7763) — recusa `npm ci` / `npm install` quando o
// `node_modules` do diretório alvo é symlink/junction pra FORA dele.
//
// Por que hook, e não `preinstall` do package.json (tentado e descartado na
// PR #7774): o `npm ci` remove a árvore antiga ANTES de disparar qualquer
// lifecycle script. Medido ao vivo (Windows, npm 11, 09/09/2026) — a linha
// `npm warn reify Removing non-directory .../node_modules` aparece ANTES do
// `> preinstall`, e o diretório apontado pela junction já sai vazio; quando o
// guard roda, `node_modules` é ENOENT e ele legitimamente libera. Um
// `preinstall` aqui seria pior que nada: falsa garantia mecânica no lugar da
// vigilância humana que a regra em prosa ainda provia.
//
// O hook roda ANTES do npm sequer ser invocado, que é o único ponto do fluxo
// real onde ainda dá pra ver o symlink intacto.
//
// COBERTURA HONESTA: protege comandos rodados por uma sessão de Claude Code
// DESTE projeto (o vetor do #7763 — subagente bootstrapando worktree). Um
// `npm ci` digitado num terminal fora do Claude Code não passa por aqui.
//
// Self-contained de propósito: nenhum import de `.ts` (convenção dos hooks
// irmãos). A paridade com `scripts/lib/worktree-node-modules-guard.ts` é
// travada por teste (`test/worktree-node-modules-guard.test.ts`).

import { lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Divide o comando em segmentos separados por `&&`, `;`, `||`, `|`, nova linha. */
export function commandSegments(command) {
  return String(command)
    .split(/(?:&&|\|\||;|\||\n)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * true quando o segmento é um `npm ci` / `npm install` / `npm i` / `npm add`
 * — os comandos que reconstroem `node_modules` e portanto apagam o que
 * estiver lá. `npm run`, `npm test`, `npm ls` etc. não contam.
 */
export function isNpmInstallSegment(segment) {
  return /^(?:[A-Za-z]:[^\s]*|[^\s]*\/)?npm(?:\.cmd)?\s+(?:ci|install|i|add)(?:\s|$)/.test(String(segment).trim());
}

/** `--prefix <dir>` / `--prefix=<dir>` redireciona o alvo do npm. */
export function npmPrefixArg(segment) {
  const eq = /--prefix=(\S+)/.exec(segment);
  if (eq) return stripQuotes(eq[1]);
  const spaced = /--prefix\s+(\S+)/.exec(segment);
  return spaced ? stripQuotes(spaced[1]) : null;
}

function stripQuotes(value) {
  return value.replace(/^['"]|['"]$/g, "");
}

/** Diretório de um `cd <dir>` (o shell mantém isso entre segmentos `&&`). */
export function cdTarget(segment) {
  const m = /^cd\s+(?:--\s+)?(\S+)/.exec(String(segment).trim());
  if (!m) return null;
  const dir = stripQuotes(m[1]);
  return dir === "-" ? null : dir;
}

/** true quando `inner` é o próprio `outer` ou está contido nele. */
function isInside(outer, inner) {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/**
 * Espelha `checkNodeModulesSymlink` de
 * `scripts/lib/worktree-node-modules-guard.ts`: bloqueia symlink pra fora do
 * diretório, e bloqueia também inspeção inconclusiva (EACCES e afins).
 * ENOENT e diretório real liberam.
 */
export function nodeModulesEscapesDir(dir) {
  const nm = resolvePath(dir, "node_modules");
  try {
    const st = lstatSync(nm);
    if (!st.isSymbolicLink()) return null;
    const target = readlinkSync(nm);
    const absTarget = isAbsolute(target) ? resolvePath(target) : resolvePath(dir, target);
    const absDir = resolvePath(dir);
    if (isInside(absDir, absTarget) || isInside(absTarget, absDir)) return null;
    return absTarget;
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    return `<inspeção falhou: ${e?.code ?? "erro desconhecido"}>`;
  }
}

/**
 * Percorre os segmentos rastreando o `cd`, e devolve `{ dir, target }` do
 * primeiro `npm install`-like cujo `node_modules` escapa do diretório.
 */
export function findBlockedNpmInstall(command, cwd, inspect = nodeModulesEscapesDir) {
  let current = cwd;
  for (const segment of commandSegments(command)) {
    const cd = cdTarget(segment);
    if (cd) {
      current = isAbsolute(cd) ? cd : resolvePath(current, cd);
      continue;
    }
    if (!isNpmInstallSegment(segment)) continue;
    const prefix = npmPrefixArg(segment);
    const dir = prefix ? (isAbsolute(prefix) ? prefix : resolvePath(current, prefix)) : current;
    const target = inspect(dir);
    if (target) return { dir, target };
  }
  return null;
}

export function blockReason({ dir, target }) {
  return (
    `[GUARD #7763] BLOQUEADO: \`node_modules\` de ${dir} é symlink/junction para ${target} — fora desse diretório. ` +
    "`npm ci`/`npm install` APAGA a árvore antiga antes de reinstalar: seguindo o link, ele esvazia o alvo " +
    "(foi assim que o checkout principal compartilhado ficou sem `node_modules` no #7763). " +
    "Remova o link e instale DENTRO do diretório: `rm node_modules && npm ci --prefer-offline`. " +
    "Cada worktree precisa do seu próprio `node_modules/` — nunca symlinkar pro principal."
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      if (payload.tool_name && payload.tool_name !== "Bash") return;
      const command = payload.tool_input?.command;
      if (typeof command !== "string") return;
      const cwd = payload.cwd || process.cwd();
      const hit = findBlockedNpmInstall(command, cwd);
      if (!hit) return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: blockReason(hit),
          },
        }),
      );
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar Bash legítimo.
    }
  });
}
