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
 *
 * ## #7058 — `import type` não afirma mais "quebra o bundle"
 *
 * A varredura acima segue TODO import textualmente, sem distinguir
 * `import type { X } from "..."` (apagado inteiro na compilação — não coloca
 * NADA no bundle, nem o módulo nem a cadeia dele) de um import de valor
 * normal. Achado ao vivo (#7058, hotfix #7057): `workers/artigos/src/
 * apoio-gate.ts` alcançava um módulo Node-only só através de um `import
 * type`, e a mensagem de violação afirmava "quebra o bundle do Worker" —
 * falso para esse caso, o que mandou quem investigou pro lugar errado.
 *
 * A política do guard NÃO mudou (opção 2 da issue, a mais barata e a
 * escolhida): uma aresta de import de Worker para módulo Node-only continua
 * sendo VIOLAÇÃO mesmo quando é só `import type` — é frágil por construção
 * (troca `import type` por `import` numa refatoração futura e a quebra vira
 * real, em runtime). O que muda é só o TEXTO: `reachableViaValueOnly` abaixo
 * calcula separadamente quais arquivos são alcançáveis por uma cadeia de
 * imports que NÃO passa por nenhuma aresta `import type`/`export type` — se
 * o arquivo violador só é alcançável via aresta(s) type-only, a mensagem diz
 * isso (aresta frágil) em vez de "quebra o bundle" (falso nesse caso).
 *
 * Detecção de `typeOnly` é por LINHA (a linha física que contém o `from`/
 * `import(` casado), não por AST — cobre o caso comum de 1 import por linha
 * (inclusive o do incidente real, `import type { ApoioNivel } from "...";`
 * numa linha só). Um `import type {\n  X,\n} from "...";` multi-linha foge
 * deste escopo estreito, mesmo espírito documentado acima para
 * `usesImportMetaUrlNodePattern`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_DIR = join(ROOT, "workers");

/** Um edge de import: o specifier + se a linha é `import type`/`export type` (#7058). */
interface ImportEdge {
  spec: string;
  /**
   * `true` quando a linha física que contém este import começa com `import
   * type`/`export type` — apagado inteiro na compilação, nunca entra no
   * bundle. Ver docstring do módulo, seção "#7058".
   */
  typeOnly: boolean;
}

/**
 * Specifiers de import estático (com ou sem `from`), re-export e import()
 * dinâmico de um arquivo TS. O primeiro grupo alternativo cobre imports
 * side-effect-only (`import "./foo.ts";`, sem `from`) — sem isso, um arquivo
 * alcançável só por esse tipo de import ficaria invisível ao BFS.
 */
function importSpecifiers(file: string): ImportEdge[] {
  const src = readFileSync(file, "utf8");
  const out: ImportEdge[] = [];
  const re = /(?:^\s*import\s*['"]([^'"]+)['"]|(?:from|import\s*\()\s*['"]([^'"]+)['"])/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const spec = m[1] ?? m[2];
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const lineEndIdx = src.indexOf("\n", m.index);
    const line = src.slice(lineStart, lineEndIdx === -1 ? src.length : lineEndIdx);
    const typeOnly = /^\s*(?:import|export)\s+type\s/.test(line);
    out.push({ spec, typeOnly });
  }
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

/** BFS a partir do entrypoint, retornando todos os arquivos alcançáveis via imports relativos (type OU valor). */
function reachableFiles(entrypoint: string): string[] {
  const seen = new Set<string>([entrypoint]);
  const queue = [entrypoint];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const { spec } of importSpecifiers(file)) {
      const resolved = resolveRelative(file, spec);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return [...seen];
}

/**
 * BFS a partir do entrypoint seguindo SÓ arestas de import de VALOR (nunca
 * `import type`/`export type`) — o subconjunto de `reachableFiles` que de
 * fato entra no bundle. Um arquivo alcançável em `reachableFiles` mas
 * ausente daqui só chega lá através de aresta(s) `import type`, que o
 * bundler apaga inteiras (#7058) — inclusive qualquer import de VALOR que
 * esse arquivo faça mais adiante, porque a aresta que levaria até ele nunca
 * é enfileirada.
 */
function reachableViaValueOnly(entrypoint: string): string[] {
  const seen = new Set<string>([entrypoint]);
  const queue = [entrypoint];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const { spec, typeOnly } of importSpecifiers(file)) {
      if (typeOnly) continue;
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
      // #7058: a política continua igual (import type crossing a fronteira
      // ainda É violação) — só a MENSAGEM diferencia os dois casos, porque
      // um é falso ("quebra o bundle") e o outro não.
      const valueReachable = new Set(reachableViaValueOnly(entrypoint));
      for (const file of reachableFiles(entrypoint)) {
        if (usesImportMetaUrlNodePattern(file)) {
          const reallyBreaksBundle = valueReachable.has(file);
          const detail = reallyBreaksBundle
            ? "padrão Node-only que quebra o bundle do Worker"
            : "padrão Node-only alcançado só via `import type`/`export type` — apagado na compilação, NÃO " +
              "entra no bundle final, mas ainda cria uma aresta frágil de import de Worker para módulo " +
              "Node-only (troque `import type` por um tipo extraído pra um módulo puro, ver #7058)";
          violations.push(
            `worker "${worker}" (${entrypoint.slice(ROOT.length + 1)}) alcança ` +
              `${file.slice(ROOT.length + 1)}, que chama fileURLToPath(import.meta.url) ` +
              `— ${detail}`,
          );
        }
      }
    }
    assert.deepEqual(violations, [], `violações encontradas:\n  ${violations.join("\n  ")}`);
  });
});

describe("#7058 — importSpecifiers distingue import type de import de valor", () => {
  it("`import type { X } from '...'` na mesma linha é marcado typeOnly:true", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-bundle-type-only-"));
    try {
      const file = join(dir, "f.ts");
      writeFileSync(file, `import type { ApoioNivel } from "./node-only.ts";\nexport {};\n`, "utf8");
      const edges = importSpecifiers(file);
      assert.equal(edges.length, 1);
      assert.equal(edges[0].spec, "./node-only.ts");
      assert.equal(edges[0].typeOnly, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`export type { X } from '...'` também é typeOnly:true", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-bundle-type-only-"));
    try {
      const file = join(dir, "f.ts");
      writeFileSync(file, `export type { ApoioNivel } from "./node-only.ts";\n`, "utf8");
      const edges = importSpecifiers(file);
      assert.equal(edges[0].typeOnly, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("import normal (com ou sem `from`) é typeOnly:false", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-bundle-type-only-"));
    try {
      const file = join(dir, "f.ts");
      writeFileSync(
        file,
        `import { X } from "./a.ts";\nimport "./b.ts";\nconst y = import("./c.ts");\n`,
        "utf8",
      );
      const edges = importSpecifiers(file);
      assert.equal(edges.length, 3);
      assert.deepEqual(
        edges.map((e) => e.typeOnly),
        [false, false, false],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#7058 — reachableViaValueOnly exclui o que só é alcançável via import type", () => {
  /**
   * Fixture reproduz o formato do incidente real: entrypoint.ts (papel do
   * Worker) importa `ApoioNivel` de node-only.ts só via `import type` —
   * node-only.ts em si chama `fileURLToPath(import.meta.url)`. Em produção
   * isso não quebra o bundle (a aresta type-only some na compilação); antes
   * do #7058 a mensagem de violação afirmava o contrário.
   */
  function buildFixture(): { dir: string; entrypoint: string; nodeOnly: string } {
    const dir = mkdtempSync(join(tmpdir(), "worker-bundle-fixture-"));
    const entrypoint = join(dir, "entrypoint.ts");
    const nodeOnly = join(dir, "node-only.ts");
    writeFileSync(
      entrypoint,
      `import type { ApoioNivel } from "./node-only.ts";\nexport function handler(x: ApoioNivel) { return x; }\n`,
      "utf8",
    );
    writeFileSync(
      nodeOnly,
      `import { fileURLToPath } from "node:url";\nexport type ApoioNivel = "amigo" | "patrono";\nconst ROOT = fileURLToPath(import.meta.url);\nexport { ROOT };\n`,
      "utf8",
    );
    return { dir, entrypoint, nodeOnly };
  }

  it("node-only.ts está em reachableFiles mas NÃO em reachableViaValueOnly quando só chega via import type", () => {
    const { dir, entrypoint, nodeOnly } = buildFixture();
    try {
      assert.ok(reachableFiles(entrypoint).includes(nodeOnly), "reachableFiles deveria incluir node-only.ts");
      assert.ok(
        !reachableViaValueOnly(entrypoint).includes(nodeOnly),
        "reachableViaValueOnly NÃO deveria incluir node-only.ts — só chega lá via import type",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com um import de VALOR adicional pro mesmo arquivo, reachableViaValueOnly passa a incluí-lo", () => {
    const { dir, entrypoint, nodeOnly } = buildFixture();
    try {
      // Adiciona uma 2ª aresta de VALOR pro mesmo node-only.ts — agora existe
      // ao menos um caminho 100% de imports de valor até ele.
      writeFileSync(
        entrypoint,
        readFileSync(entrypoint, "utf8") + `import "./node-only.ts";\n`,
        "utf8",
      );
      assert.ok(
        reachableViaValueOnly(entrypoint).includes(nodeOnly),
        "com uma aresta de VALOR também presente, o arquivo passa a ser bundlado de verdade",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mensagem de violação NÃO afirma 'quebra o bundle' quando o arquivo só é alcançável via import type", () => {
    const { dir, entrypoint, nodeOnly } = buildFixture();
    try {
      const valueReachable = new Set(reachableViaValueOnly(entrypoint));
      const reallyBreaksBundle = valueReachable.has(nodeOnly);
      assert.equal(reallyBreaksBundle, false);
      const detail = reallyBreaksBundle
        ? "padrão Node-only que quebra o bundle do Worker"
        : "padrão Node-only alcançado só via `import type`/`export type` — apagado na compilação, NÃO " +
          "entra no bundle final, mas ainda cria uma aresta frágil de import de Worker para módulo " +
          "Node-only (troque `import type` por um tipo extraído pra um módulo puro, ver #7058)";
      assert.doesNotMatch(detail, /quebra o bundle/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
