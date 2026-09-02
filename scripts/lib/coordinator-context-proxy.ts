/**
 * coordinator-context-proxy.ts (#6634 Direction 2)
 *
 * **Estimativa de tokens do coordenador quando o harness não expõe `usage`**
 * (#3453 Rec 1, #6634, .claude/skills/diaria-overnight/SKILL.md Fase 0 passo 1).
 *
 * O coordenador (overnight/develop/continuo) consome dezenas de milhares de
 * tokens ao longo da rodada — CLAUDE.md (~71KB), context/* (~327KB), plan.json,
 * run-log entries já processados — mas **nunca reporta esse gasto** via
 * `harness_usage` ou `coordinator_tokens_estimate`. #6634 mostrou que 9/9
 * rodadas observadas tinham `coordinator_tokens_estimate` em `source: "unavailable"`
 * (ou simplesmente inexistente). A categoria "Coordenador" some da contagem
 * e da tabela de aggregate-session-tokens.
 *
 * `context_size_proxy` é a **fallback mecânica** documentada pelo SKILL: quando
 * o coordenador não pôs emitir `coordinator_tokens_estimate` com
 * `source: "harness_usage"`, a estimativa baseada em tamanho de arquivo
 * (contexto accumulado ÷ bytes/token) é a próxima fonte autoritativa — nunca
 * zero, nunca omitido.
 *
 * ## Como usar
 *
 * O coordenador chama este CLI no checkpoint de inírio de cada fase, capta o
 * output e registra via `log-event.ts`:
 *
 *   npx tsx scripts/lib/coordinator-context-proxy.ts \
 *     --edition 260827 --kind overnight --phase fase_1_a \
 *     | xargs -I{} npx tsx scripts/log-event.ts \
 *       --agent overnight --edition 260827 \
 *       --message coordinator_tokens_estimate \
 *       --details '{"tokens": {}, "source": "context_size_proxy"}'
 *
 * ## Ratio de conversão
 *
 * 4 bytes/token — conservador para conteúdo code-heavy (CLAUDE.md, TS, JSON,
 * specs em markdown). Claude's tokenizer médio é ~3.5, mas o contexto fixo
 * dominado por código/spec justifica o overhead. Nunca usar 3.0 — sobrestima 33%.
 *
 * @see .claude/skills/diaria-overnight/SKILL.md (Fase 0 passo 1 — contrato de source)
 * @see .claude/skills/diaria-continuo/SKILL.md (item 6 — mesmo contrato)
 * @see .claude/skills/diaria-develop/SKILL.md (§6 — mesmo contrato)
 * @see scripts/aggregate-session-tokens.ts (consumidor do evento `context_size_proxy`)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./cli-args.ts";

/** Bytes por token — conservador para conteúdo code-heavy (ver docstring). */
export const BYTES_PER_TOKEN = 4;

/**
 * Diretórios/arquivos fixos cujo conteúdo compõe o contexto do coordenador
 * em TODA sessão (não por rodada). `context/` é lido recursivamente até 1 nível de subdirs.
 */
export const CONTEXT_BASE_FILES = ["CLAUDE.md"];
export const CONTEXT_BASE_DIRS = ["context"];

/** Profundidade máxima de recursão para context/ subdirs — 1 (context/ +
 * subdirs imediatos como templates/, publishers/, snippets/). Não há arquivos
 * relevantes em context/ além desse nível. */
const MAX_CONTEXT_DEPTH = 1;

export interface ContextMeasurement {
  /** Total de bytes de todos os arquivos combinados. */
  totalBytes: number;
  /** Estimativa de tokens = floor(totalBytes / bytesPerToken). */
  estimatedTokens: number;
  /** Componentes que compuseram a estimativa, para debugging/audit trail. */
  components: { name: string; bytes: number; tokens: number }[];
}

/**
 * Pure: soma os bytes de conteúdos em string e converte para tokens.
 * Não toca filesystem — o caller resolve os arquivos e passa os conteúdos.
 */
export function measureContextFromContents(
  components: { name: string; content: string }[],
  bytesPerToken: number = BYTES_PER_TOKEN,
): ContextMeasurement {
  const parts: { name: string; bytes: number; tokens: number }[] = [];
  let totalBytes = 0;

  for (const { name, content } of components) {
    const bytes = Buffer.byteLength(content, "utf8");
    parts.push({ name, bytes, tokens: Math.floor(bytes / bytesPerToken) });
    totalBytes += bytes;
  }

  return {
    totalBytes,
    estimatedTokens: Math.floor(totalBytes / bytesPerToken),
    components: parts,
  };
}

/**
 * Pure: coleta o conteúdo de todos os arquivos de contexto fixo do coordenador
 * (CLAUDE.md + context/) a partir dos caminhos resolvidos em `rootDir`.
 *
 * `fsShims` é injetável para teste — default usa o filesystem real.
 * Fail-soft: arquivos/diretórios ausentes ou unreadable são pulados silenciosamente.
 */
export function collectContextFiles(
  rootDir: string,
  fsShims?: {
    readFileSync: (path: string, encoding: string) => string;
    existsSync: (path: string) => boolean;
    readdirSync: (path: string, opts: { withFileTypes: true }) => { name: string; isDirectory(): boolean }[];
  },
): { name: string; content: string }[] {
  const fs = fsShims ?? {
    readFileSync: (p: string) => readFileSync(p, "utf8"),
    existsSync: (p: string) => existsSync(p),
    readdirSync: (p: string) => readdirSync(p, { withFileTypes: true }),
  };

  const components: { name: string; content: string }[] = [];

  // CLAUDE.md
  for (const name of CONTEXT_BASE_FILES) {
    const p = join(rootDir, name);
    if (fs.existsSync(p)) {
      try {
        components.push({ name, content: fs.readFileSync(p, "utf8") });
      } catch {
        // unreadable — pula silenciosamente
      }
    }
  }

  // context/ (recursivo até MAX_CONTEXT_DEPTH)
  for (const dir of CONTEXT_BASE_DIRS) {
    collectContextDir(rootDir, dir, 0, components, fs);
  }

  return components;
}

interface FsShim {
  readFileSync: (path: string, encoding: string) => string;
  existsSync: (path: string) => boolean;
  readdirSync: (path: string, opts: { withFileTypes: true }) => { name: string; isDirectory(): boolean }[];
}

/**
 * Recursão interna para coletar arquivos de context/ até MAX_CONTEXT_DEPTH.
 * Só .md e .json — outros formatos (imagens, binários) são skipados.
 */
function collectContextDir(
  rootDir: string,
  subPath: string,
  depth: number,
  components: { name: string; content: string }[],
  fs: FsShim,
): void {
  if (depth > MAX_CONTEXT_DEPTH) return;
  const dir = join(rootDir, subPath);
  if (!fs.existsSync(dir)) return;

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const relPath = `${subPath}/${entry.name}`;
    if (entry.isDirectory()) {
      collectContextDir(rootDir, relPath, depth + 1, components, fs);
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".json")) {
      const fullPath = join(rootDir, relPath);
      try {
        components.push({ name: relPath, content: fs.readFileSync(fullPath, "utf8") });
      } catch {
        // unreadable — pula silenciosamente
      }
    }
  }
}

/**
 * Pure: estima os tokens do coordenador a partir de componentes já coletados.
 * Combina contexto fixo (CLAUDE.md + context/) + plan.json da rodada +
 * run-log entries para aquele edition/agent.
 *
 * Todos os inputs são strings (conteúdos já lidos) — a função não toca
 * filesystem. O CLI (`main`) resolve os arquivos reais e chama esta função.
 */
export function estimateCoordinatorTokensFromContents(opts: {
  contextFiles: { name: string; content: string }[];
  planContent?: string;
  runLogLines?: string[];
  bytesPerToken?: number;
}): ContextMeasurement {
  const bpt = opts.bytesPerToken ?? BYTES_PER_TOKEN;
  const components: { name: string; content: string }[] = [...opts.contextFiles];

  if (opts.planContent) {
    components.push({ name: "plan.json", content: opts.planContent });
  }

  if (opts.runLogLines && opts.runLogLines.length > 0) {
    components.push({ name: "run-log.jsonl (this round)", content: opts.runLogLines.join("\n") });
  }

  return measureContextFromContents(components, bpt);
}

// ---------------------------------------------------------------------------
// Orquestração (filesystem I/O — separada das functions puras acima)
// ---------------------------------------------------------------------------

/** Regex para ids de rodada: AAMMDD seguido de sufixo opcional (b, c, ...). */
const ROUND_ID_RE = /^\d{6}[a-z]*$/;

/**
 * Resolve o caminho do run-log.jsonl a partir de platform.config.json,
 * fallback pra `data/run-log.jsonl`. Mesmo padrão de `resolveRunLogPath` em
 * `scripts/lib/run-log.ts`.
 */
function resolveRunLogPath(rootDir: string): string {
  const cfgPath = resolve(rootDir, "platform.config.json");
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { logging?: { path?: string } };
      if (cfg?.logging?.path) return resolve(rootDir, cfg.logging.path);
    } catch {
      // malformed config — fallback
    }
  }
  return resolve(rootDir, "data", "run-log.jsonl");
}

/**
 * Resolve e lê todos os arquivos necessários pro `context_size_proxy` de uma
 * rodada específica. Fail-soft: arquivos ausentes são pulados, nunca lança.
 */
export function resolveCoordinatorContextFiles(
  rootDir: string,
  edition: string,
  kind: "overnight" | "develop" | "continuo",
): {
  contextFiles: { name: string; content: string }[];
  planContent?: string;
  runLogLines: string[];
} {
  const contextFiles = collectContextFiles(rootDir);

  // plan.json da rodada: data/{kind}/{edition}/plan.json
  const planPath = join(rootDir, "data", kind, edition, "plan.json");
  let planContent: string | undefined;
  if (existsSync(planPath)) {
    try {
      planContent = readFileSync(planPath, "utf8");
    } catch {
      // unreadable — deixa undefined
    }
  }

  // run-log entries para este edition + agent
  const logPath = resolveRunLogPath(rootDir);
  let runLogLines: string[] = [];
  if (existsSync(logPath)) {
    try {
      const allLines = readFileSync(logPath, "utf8").split("\n");
      runLogLines = allLines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        try {
          const ev = JSON.parse(trimmed) as { agent?: string; edition?: string };
          return ev.agent === kind && ev.edition === edition;
        } catch {
          return false;
        }
      });
    } catch {
      // unreadable — deixa vazio
    }
  }

  return { contextFiles, planContent, runLogLines };
}

/**
 * Estima os tokens do coordenador via `context_size_proxy` para uma rodada.
 * Fail-soft: retorna `null` se não consegue ler nada (não lança).
 */
export function estimateCoordinatorContextTokens(
  rootDir: string,
  edition: string,
  kind: "overnight" | "develop" | "continuo",
  bytesPerToken: number = BYTES_PER_TOKEN,
): ContextMeasurement | null {
  const { contextFiles, planContent, runLogLines } = resolveCoordinatorContextFiles(
    rootDir,
    edition,
    kind,
  );

  if (contextFiles.length === 0 && !planContent) return null;

  return estimateCoordinatorTokensFromContents({
    contextFiles,
    planContent,
    runLogLines,
    bytesPerToken,
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { values, flags } = parseArgs(argv);
  const edition = values.edition;
  const kind = values.kind;

  if (!edition || !kind) {
    console.error(
      `[coordinator-context-proxy] uso: --edition {AAMMDD} --kind {overnight|develop|continuo} [--bytes-per-token N] [--json]`,
    );
    process.exit(2);
  }

  if (kind !== "overnight" && kind !== "develop" && kind !== "continuo") {
    console.error(
      `[coordinator-context-proxy] kind inválido: ${kind} (esperado: overnight|develop|continuo)`,
    );
    process.exit(2);
  }

  const root = resolve(process.cwd());
  const bpt = values["bytes-per-token"] ? Number(values["bytes-per-token"]) : BYTES_PER_TOKEN;

  if (values.phase) {
    // --phase opcional: loga pro stderr pro audit trail, não altera a conta.
    console.error(
      `[coordinator-context-proxy] ${kind}/${edition} phase=${values.phase} source=context_size_proxy`,
    );
  }

  const result = estimateCoordinatorContextTokens(
    root,
    edition,
    kind as "overnight" | "develop" | "continuo",
    bpt,
  );

  if (!result) {
    console.error(
      `[coordinator-context-proxy] nenhum arquivo de contexto encontrado para ${kind}/${edition}`,
    );
    process.exit(1);
  }

  if (flags.has("json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(String(result.estimatedTokens) + "\n");
  }
}
