/**
 * test/worker-bundle-node-only-imports.test.ts (#4318)
 *
 * Regressão do incidente 260729: o deploy do worker `arquivo` (serve
 * arquivo.diar.ia.br, renderiza HTML on-the-fly a cada request) passou a
 * falhar no CI (`wrangler deploy`, `.github/workflows/deploy-arquivo.yml`)
 * porque o commit 5bc6fbbe (#4265) adicionou, em
 * `workers/arquivo/src/render-archive.ts`, um import de
 * `scripts/lib/shared/curadoria-page.ts` → `../canonical-urls.ts` →
 * `../dedup.ts` (só pra reusar `normalizeTitle`, que na verdade mora em
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
 * (bundle build), derrubando o deploy inteiro (versão previamente deployada
 * seguiu servindo — não foi um outage ao vivo, mas todo deploy subsequente
 * ficava bloqueado).
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
 * relativos recursivamente, e falha se qualquer arquivo alcançável CHAMA
 * `fileURLToPath(import.meta.url)` (a assinatura exata que quebra o bundle —
 * ver escopo abaixo) no próprio código-fonte.
 *
 * Escopo deliberadamente estreito: detecta essa assinatura específica, não
 * "qualquer dependência Node-only" (outros padrões como `__dirname` top-level
 * ou `process.cwd()` não são cobertos aqui). A proteção é GERAL no sentido de
 * "qualquer worker futuro, não só `arquivo`" — não no sentido de cobrir toda
 * forma possível de quebrar um bundle.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_DIR = join(ROOT, "workers");

/**
 * Specifiers de import estático (com ou sem `from`), re-export e import()
 * dinâmico de um arquivo TS. O primeiro grupo alternativo cobre imports
 * side-effect-only (`import "./foo.ts";`, sem `from`) — sem isso, um arquivo
 * alcançável só por esse tipo de import ficaria invisível ao BFS.
 */
function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /(?:^\s*import\s*['"]([^'"]+)['"]|(?:from|import\s*\()\s*['"]([^'"]+)['"])/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1] ?? m[2]);
  return out;
}

/** Resolve um specifier relativo pra um path de arquivo existente, ou null. */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // node:/npm/workers-internos — fora do scan
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Detecta a chamada `fileURLToPath(import.meta.url)` (com espaço opcional)
 * no código-fonte do arquivo. Casa a chamada perigosa DIRETO — em vez de
 * exigir que `node:url` seja importado no MESMO arquivo — porque esse
 * repositório tem o hábito comprovado (#2833, `dedup.ts` re-exportando
 * `title-similarity.ts`) de mover um helper pra outro módulo e re-exportar;
 * `fileURLToPath` chegando via re-export deixaria uma checagem baseada em
 * "import de node:url neste arquivo" cega pro caso real. Casar a chamada em
 * si é robusto a esse padrão e não depende de onde `fileURLToPath` foi
 * originalmente importado.
 */
function usesImportMetaUrlNodePattern(file: string): boolean {
  const src = readFileSync(file, "utf8");
  return /fileURLToPath\s*\(\s*import\.meta\.url\s*\)/.test(src);
}

/** BFS a partir do entrypoint, retornando todos os arquivos alcançáveis via imports relativos. */
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

interface WorkerEntry {
  worker: string;
  /** Path absoluto resolvido do `main` declarado, existente ou não — ver `mainExists`. */
  entrypoint: string;
  /** `false` sinaliza que `main` foi declarado no wrangler.toml mas o arquivo não existe. */
  mainExists: boolean;
}

/**
 * Lista todo worker com `main = "..."` em `workers/{nome}/wrangler.toml`.
 * Inclui workers cujo `main` declarado NÃO resolve pra um arquivo existente
 * (`mainExists: false`) em vez de descartá-los silenciosamente — um `main`
 * quebrado (typo, path pré-build) é ele próprio um sinal de configuração
 * inválida que o teste abaixo trata como violação, não como ausência.
 */
function listWorkerEntrypoints(): WorkerEntry[] {
  if (!existsSync(WORKERS_DIR)) return [];
  const out: WorkerEntry[] = [];
  for (const name of readdirSync(WORKERS_DIR)) {
    const wranglerToml = join(WORKERS_DIR, name, "wrangler.toml");
    if (!existsSync(wranglerToml)) continue;
    const src = readFileSync(wranglerToml, "utf8");
    const m = /^\s*main\s*=\s*["']([^"']+)["']/m.exec(src);
    if (!m) continue;
    const entrypoint = resolve(join(WORKERS_DIR, name), m[1]);
    out.push({ worker: name, entrypoint, mainExists: existsSync(entrypoint) });
  }
  return out;
}

describe("workers não bundlam módulos Node-only via fileURLToPath(import.meta.url) (#4318)", () => {
  const workers = listWorkerEntrypoints();

  it("sanity: descobriu pelo menos os workers conhecidos com wrangler.toml", () => {
    assert.ok(workers.length >= 5, `esperava >=5 workers com main= em wrangler.toml, achou ${workers.length}`);
  });

  it("nenhum worker declara main= apontando pra arquivo inexistente, e nenhum alcança fileURLToPath(import.meta.url)", () => {
    const violations: string[] = [];
    for (const { worker, entrypoint, mainExists } of workers) {
      if (!mainExists) {
        violations.push(
          `worker "${worker}" declara main="${entrypoint.slice(ROOT.length + 1)}" mas o arquivo não existe`,
        );
        continue;
      }
      for (const file of reachableFiles(entrypoint)) {
        if (usesImportMetaUrlNodePattern(file)) {
          violations.push(
            `worker "${worker}" (${entrypoint.slice(ROOT.length + 1)}) alcança ` +
              `${file.slice(ROOT.length + 1)}, que chama fileURLToPath(import.meta.url) ` +
              `— padrão Node-only que quebra o bundle do Worker`,
          );
        }
      }
    }
    assert.deepEqual(violations, [], `violações encontradas:\n  ${violations.join("\n  ")}`);
  });
});
