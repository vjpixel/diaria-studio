/**
 * scripts/lib/worker-import-closure.ts (#10637)
 *
 * Fecho transitivo dos imports RELATIVOS de um Worker, a partir do `main`
 * do `wrangler.toml`/`.jsonc` — o mesmo grafo que o `wrangler deploy`
 * empacota. Serve para responder "que arquivos FORA de `workers/{dir}/`
 * entram no bundle deste Worker?", e com isso exigir que o `paths:` do
 * workflow de deploy cubra cada um deles (guard em
 * `test/workers-deploy-workflow-coverage.test.ts`).
 *
 * Sem isso, mudar um módulo compartilhado em `scripts/lib/**` não dispara
 * o redeploy do Worker que o importa, e o código no ar defasa em silêncio
 * até o alarme `Diaria-Worker-Drift-Check` (que só olha `workers/{dir}/`).
 *
 * Parser deliberadamente simples (regex, sem TypeScript compiler): erra
 * para MAIS (um import citado em comentário entra no fecho), nunca para
 * menos — falso positivo custa um redeploy no-op, falso negativo é o bug.
 * Por isso `import type` também entra: o bundler apaga, mas distinguir
 * statement type-only por regex arrisca engolir um import real vizinho.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Extrai os especificadores RELATIVOS (`./`, `../`) de um fonte TS/JS. */
export function extractRelativeSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  const patterns: RegExp[] = [
    // `… from "…"` — cobre import/export nomeado, default, namespace e
    // multi-linha sem precisar achar o início do statement.
    /\bfrom\s*["']([^"']+)["']/g,
    // import "…" (side-effect)
    /\bimport\s*["']([^"']+)["']/g,
    // import("…") dinâmico
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.add(m[1]);
  }

  return [...specs].filter((s) => s.startsWith("./") || s.startsWith("../"));
}

const RESOLVE_EXTENSIONS = [".ts", ".mts", ".tsx", ".js", ".mjs"];

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

/** Resolve um especificador relativo para um arquivo existente, ou `null`. */
export function resolveRelativeSpecifier(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  if (isFile(base)) return base;
  // `./foo.js` apontando pra `foo.ts` (convenção ESM do TypeScript).
  if (/\.(m?js)$/.test(base)) {
    const asTs = base.replace(/\.m?js$/, (ext) => (ext === ".mjs" ? ".mts" : ".ts"));
    if (isFile(asTs)) return asTs;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (isFile(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const idx = join(base, `index${ext}`);
    if (isFile(idx)) return idx;
  }
  return null;
}

/** Lê o `main` do wrangler.toml/.jsonc do worker; default `src/index.ts`. */
export function readWorkerMain(workerAbsDir: string): string {
  const toml = join(workerAbsDir, "wrangler.toml");
  if (existsSync(toml)) {
    const m = /^\s*main\s*=\s*["']([^"']+)["']/m.exec(readFileSync(toml, "utf8"));
    if (m) return m[1];
  }
  const jsonc = join(workerAbsDir, "wrangler.jsonc");
  if (existsSync(jsonc)) {
    const m = /"main"\s*:\s*"([^"]+)"/.exec(readFileSync(jsonc, "utf8"));
    if (m) return m[1];
  }
  return "src/index.ts";
}

export interface WorkerClosure {
  /** Arquivos do fecho FORA de `workers/{dir}/`, relativos à raiz do repo, com `/`. */
  external: string[];
  /** Especificadores relativos que não resolveram para arquivo (`arquivo: spec`). */
  unresolved: string[];
}

/** Caminho relativo à raiz, sempre com `/` (o formato do `paths:` do Actions). */
function toRepoPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/**
 * Fecho transitivo a partir do `main` do worker. Segue também os imports
 * DENTRO de `scripts/lib/**` (um módulo compartilhado que importa outro
 * puxa os dois pro bundle).
 */
export function computeWorkerExternalImports(root: string, workerDir: string): WorkerClosure {
  const workerAbs = resolve(root, "workers", workerDir);
  const entry = resolve(workerAbs, readWorkerMain(workerAbs));
  const seen = new Set<string>();
  const external = new Set<string>();
  const unresolved: string[] = [];
  const stack = [entry];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!isFile(file)) {
      unresolved.push(`${toRepoPath(root, file)}: (entry inexistente)`);
      continue;
    }
    const insideWorker = file.startsWith(workerAbs + sep);
    if (!insideWorker) external.add(toRepoPath(root, file));

    // Só código é varrido; JSON/HTML/etc. importados entram no fecho mas não têm imports.
    if (!/\.(m?[jt]sx?|mts)$/.test(file)) continue;
    for (const spec of extractRelativeSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveRelativeSpecifier(file, spec);
      if (target === null) {
        unresolved.push(`${toRepoPath(root, file)}: ${spec}`);
        continue;
      }
      if (!seen.has(target)) stack.push(target);
    }
  }

  return { external: [...external].sort(), unresolved: unresolved.sort() };
}

/**
 * Extrai a lista `on.push.paths` de um workflow do GitHub Actions. Parser
 * por indentação (o repo não tem lib YAML): acha `push:` dentro de `on:`,
 * depois `paths:` dentro de `push:`, e coleta os itens `- '…'`.
 */
export function extractPushPaths(workflowYaml: string): string[] {
  const lines = workflowYaml.split(/\r?\n/);
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const isSkippable = (l: string) => l.trim() === "" || l.trim().startsWith("#");

  const onIdx = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onIdx < 0) return [];

  let pushIdx = -1;
  for (let i = onIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isSkippable(l)) continue;
    if (indentOf(l) === 0) break; // saiu do bloco `on:`
    if (/^\s+push:\s*$/.test(l)) {
      pushIdx = i;
      break;
    }
  }
  if (pushIdx < 0) return [];
  const pushIndent = indentOf(lines[pushIdx]);

  let pathsIdx = -1;
  for (let i = pushIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isSkippable(l)) continue;
    if (indentOf(l) <= pushIndent) break;
    if (/^\s+paths:\s*$/.test(l)) {
      pathsIdx = i;
      break;
    }
  }
  if (pathsIdx < 0) return [];
  const pathsIndent = indentOf(lines[pathsIdx]);

  const out: string[] = [];
  for (let i = pathsIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isSkippable(l)) continue;
    if (indentOf(l) <= pathsIndent) break;
    const m = /^\s*-\s*(["']?)(.+?)\1\s*(#.*)?$/.exec(l);
    if (m) out.push(m[2]);
  }
  return out;
}

/** Converte um filtro de `paths:` do Actions (`*`, `**`, `?`) em RegExp. */
export function actionsPathPatternToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` casa zero ou mais diretórios; `**` final casa qualquer coisa.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Arquivos de `files` que nenhum filtro de `patterns` cobre. Respeita
 * negação (`!padrão`) na ordem, como o Actions: o último filtro que casa
 * decide.
 */
export function uncoveredByPaths(files: string[], patterns: string[]): string[] {
  const compiled = patterns.map((p) =>
    p.startsWith("!")
      ? { negate: true, re: actionsPathPatternToRegExp(p.slice(1)) }
      : { negate: false, re: actionsPathPatternToRegExp(p) },
  );
  return files.filter((f) => {
    let included = false;
    for (const { negate, re } of compiled) {
      if (re.test(f)) included = !negate;
    }
    return !included;
  });
}
