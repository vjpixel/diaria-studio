/**
 * assert-test-discovery.ts (#1948)
 *
 * Guard anti-vacuidade, roda como `pretest` (antes do `npm test` = `node
 * --import tsx --test`). `node --test` sai com **exit 0 mesmo descobrindo 0
 * arquivos** — uma suíte "verde vazia" passaria a CI silenciosamente. Este
 * guard conta os arquivos `*.test.ts` do repo e **falha** se ficar abaixo de um
 * piso conservador, fazendo o caso de **arquivos de teste sumirem do disco**
 * (test dir removido/renomeado, .gitignore errado num clone) explodir alto em
 * vez de passar verde.
 *
 * ESCOPO (o que NÃO cobre): conta arquivos no FILESYSTEM, independente do
 * runner. `listTestFiles` abaixo é o MESMO walk usado por `scripts/run-tests.ts`
 * (#6495) pra montar a lista explícita passada a `node --test` — as duas fontes
 * não podem divergir por construção (função compartilhada), então o gap
 * "runner casa um conjunto diferente do disco" é fechado, não só teórico.
 * Este guard cobre o caso catastrófico (0 arquivos) com custo ~zero e sem
 * mexer no comando `npm test`.
 *
 * Contexto (#1948): a suspeita original ("CI verde sem rodar a suíte") NÃO
 * reproduziu — `node --import tsx --test` descobre ~6000 testes (~298 arquivos),
 * e o log da CI mostra a suíte rodando. A observação de "npm test vazio/exit 0"
 * foi artefato de captura (run em background + pipe pra grep). Este guard é
 * defesa-em-profundidade barata pra esse modo de falha não voltar despercebido.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";

/** Piso conservador: ~2/3 dos ~298 atuais. Detecta sumiço em massa dos arquivos
 *  de teste, não flutuações normais (adicionar/remover alguns arquivos). */
export const TEST_FILE_FLOOR = 200;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".wrangler", "data"]);

/** Diretórios pulados por PATH relativo à raiz (não só pelo nome do dir) —
 *  usado quando o nome sozinho é legítimo em outros lugares. `.claude/`
 *  guarda `agents/`, `skills/`, `hooks/` que continuam sendo varridos
 *  normalmente; só `.claude/worktrees` guarda cópias completas do repo
 *  (worktrees de rodadas `/diaria-overnight`/`/diaria-develop`, cada uma com
 *  sua própria `test/`) — pular `.claude` inteiro esconderia qualquer teste
 *  futuro legítimo sob esse diretório (#6801: 12.341 de 13.767 arquivos
 *  enumerados localmente vinham só de `.claude/worktrees`, inflando ~10× a
 *  contagem real de 1.426 e rodando código obsoleto de branches antigas).
 *  Cada entrada é uma lista de segmentos POSIX, casada por PREFIXO contra o
 *  path relativo percorrido — cobre também sub-worktrees aninhadas. */
const SKIP_PATH_PREFIXES: string[][] = [[".claude", "worktrees"]];

function isSkippedPath(relSegments: string[]): boolean {
  return SKIP_PATH_PREFIXES.some(
    (prefix) => relSegments.length >= prefix.length && prefix.every((seg, i) => relSegments[i] === seg),
  );
}

/** Lista arquivos `*.test.ts` recursivamente (mesma área que `node --test`
 *  varre por padrão: `test/`, `test/**`, `workers/**​/test/`), pulando dirs de
 *  build/deps. Caminhos absolutos, ordem determinística (sort lexicográfico
 *  por diretório de entrada — não depende de ordem de `readdirSync`, que o
 *  POSIX não garante). Fonte única compartilhada com `scripts/run-tests.ts`
 *  (#6495) — nunca duplicar este walk. */
export function listTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, relSegments: string[]) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, e.name);
      const rel = [...relSegments, e.name];
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (isSkippedPath(rel)) continue;
        walk(full, rel);
      } else if (e.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  walk(root, []);
  return out;
}

/** Conta arquivos `*.test.ts` (ver `listTestFiles`). */
export function countTestFiles(root: string): number {
  return listTestFiles(root).length;
}

export interface DiscoveryVerdict {
  ok: boolean;
  count: number;
  message: string;
}

/** Pure: decide se a descoberta colapsou. */
export function discoveryVerdict(count: number, floor = TEST_FILE_FLOOR): DiscoveryVerdict {
  if (count < floor) {
    return {
      ok: false,
      count,
      message: `anti-vacuity (#1948): só ${count} arquivos *.test.ts encontrados (piso ${floor}). A suíte pode não ter sido descoberta — abortando o npm test pra não passar verde vazio.`,
    };
  }
  return { ok: true, count, message: `anti-vacuity (#1948): ${count} arquivos *.test.ts (≥ ${floor}).` };
}

// CLI guard (#cli-guard): só roda como main; importável em testes sem disparar.
if (isMainModule(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const v = discoveryVerdict(countTestFiles(root));
  console.error(v.ok ? `✓ ${v.message}` : `✗ ${v.message}`);
  process.exit(v.ok ? 0 : 1);
}
