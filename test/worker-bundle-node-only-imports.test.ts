/**
 * test/worker-bundle-node-only-imports.test.ts (#4321)
 *
 * Regressão do incidente 260729: o worker `arquivo` (serve arquivo.diar.ia.br,
 * renderiza HTML on-the-fly a cada request) quebrou em produção porque o
 * commit 5bc6fbbe (#4265) adicionou, em `workers/arquivo/src/render-archive.ts`,
 * um import de `scripts/lib/shared/curadoria-page.ts` → `../canonical-urls.ts`
 * → `../dedup.ts` (só pra reusar `normalizeTitle`, que na verdade mora em
 * `title-similarity.ts` e é apenas re-exportada por `dedup.ts`) →
 * `lib/past-editions-extract.ts` → `lib/edition-utils.ts`, que computa, no
 * TOP-LEVEL do módulo:
 *
 *   const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
 *
 * Esse padrão funciona em scripts Node CLI (roda uma vez, sob controle do
 * runtime Node) mas quebra quando o módulo é bundlado por dentro de um
 * Cloudflare Worker — `import.meta.url` fica undefined nesse contexto,
 * lançando `TypeError: The "path" argument must be of type string or an
 * instance of URL. Received undefined` no MOMENTO do `wrangler deploy`
 * (bundle build), derrubando o deploy inteiro.
 *
 * `workers/cursos` e `workers/livros` importam a mesma `curadoria-page.ts`
 * sem quebrar porque geram HTML estático via script Node em BUILD-TIME — o
 * Worker deles só serve o arquivo já pronto, então o import chain problemático
 * nunca entra no bundle do Worker. `workers/arquivo` é diferente: importa
 * `render-archive.ts` DIRETO em `src/index.ts` porque renderiza a cada
 * request — por isso a cadeia inteira acaba dentro do bundle.
 *
 * Este teste faz um scan estático (mesmo padrão de `test/lib-boundary.test.ts`
 * — sem executar módulos) a partir do entrypoint de CADA worker
 * (`main = "src/index.ts"` em `workers/{nome}/wrangler.toml`), seguindo imports
 * relativos recursivamente, e falha se qualquer arquivo alcançável contém o
 * padrão Node-only `fileURLToPath(import.meta.url)` (ou equivalente:
 * `import.meta.url` + import de `node:url`) no próprio código-fonte.
 *
 * Proteção GERAL, não só pro caso do `arquivo` — qualquer worker futuro que
 * acidentalmente importe um módulo com essa assinatura é pego aqui, antes do
 * deploy quebrar em produção.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_DIR = join(ROOT, "workers");

/** Specifiers de import estático, re-export e import() dinâmico de um arquivo TS. */
function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /(?:from|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]);
  return out;
}

/** Resolve um specifier relativo pra um path de arquivo .ts existente, ou null. */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // node:/npm/workers-internos — fora do scan
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Detecta o padrão Node-only `fileURLToPath(import.meta.url)` (ou equivalente) no código-fonte. */
function usesImportMetaUrlNodePattern(file: string): boolean {
  const src = readFileSync(file, "utf8");
  if (!src.includes("import.meta.url")) return false;
  // fileURLToPath(import.meta.url) direto, ou import.meta.url atribuído a uma
  // variável e passado pra fileURLToPath/new URL(..., import.meta.url) com
  // node:url — cobre o caso real (edition-utils.ts linha 13) sem exigir
  // regex frágil demais; basta que o arquivo combine as duas peças.
  const importsNodeUrl = /from\s+['"]node:url['"]/.test(src) || /require\(['"]node:url['"]\)/.test(src);
  const usesFileURLToPath = /fileURLToPath\s*\(/.test(src);
  return importsNodeUrl && usesFileURLToPath;
}

/** BFS a partir do entrypoint, retornando todos os arquivos .ts alcançáveis via imports relativos. */
function reachableFiles(entrypoint: string): string[] {
  const seen = new Set<string>([entrypoint]);
  const queue = [entrypoint];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of importSpecifiers(file)) {
      const resolved = resolveRelative(file, spec);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return [...seen];
}

/** Lista de workers com `main = "src/index.ts"` (ou variante) em wrangler.toml. */
function listWorkerEntrypoints(): { worker: string; entrypoint: string }[] {
  if (!existsSync(WORKERS_DIR)) return [];
  const out: { worker: string; entrypoint: string }[] = [];
  for (const name of readdirSync(WORKERS_DIR)) {
    const wranglerToml = join(WORKERS_DIR, name, "wrangler.toml");
    if (!existsSync(wranglerToml)) continue;
    const src = readFileSync(wranglerToml, "utf8");
    const m = /^\s*main\s*=\s*["']([^"']+)["']/m.exec(src);
    if (!m) continue;
    const entrypoint = resolve(join(WORKERS_DIR, name), m[1]);
    if (existsSync(entrypoint)) out.push({ worker: name, entrypoint });
  }
  return out;
}

describe("workers não bundlam módulos Node-only via fileURLToPath(import.meta.url) (#4321)", () => {
  const workers = listWorkerEntrypoints();

  it("sanity: descobriu pelo menos os workers conhecidos com wrangler.toml", () => {
    assert.ok(workers.length >= 5, `esperava >=5 workers com main= em wrangler.toml, achou ${workers.length}`);
  });

  it("nenhum worker alcança um módulo com fileURLToPath(import.meta.url)", () => {
    const violations: string[] = [];
    for (const { worker, entrypoint } of workers) {
      for (const file of reachableFiles(entrypoint)) {
        if (usesImportMetaUrlNodePattern(file)) {
          violations.push(
            `worker "${worker}" (${entrypoint.slice(ROOT.length + 1)}) alcança ` +
              `${file.slice(ROOT.length + 1)}, que usa fileURLToPath(import.meta.url) ` +
              `— padrão Node-only que quebra o bundle do Worker`,
          );
        }
      }
    }
    assert.deepEqual(violations, [], `violações encontradas:\n  ${violations.join("\n  ")}`);
  });
});
