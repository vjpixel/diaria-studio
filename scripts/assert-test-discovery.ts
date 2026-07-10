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
 * runner. Se o `node --test` parasse de casar arquivos que existem no disco
 * (ex.: alguém adicionar um glob custom quebrado ao script `test`), isto NÃO
 * pega — pra isso seria preciso capturar a contagem reportada pelo runner.
 * Hoje o `test` usa o default sem glob custom, então o gap é teórico; este
 * guard cobre o caso catastrófico (0 arquivos) com custo ~zero e sem mexer no
 * comando `npm test`.
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

/** Conta arquivos `*.test.ts` recursivamente (mesma área que `node --test`
 *  varre: `test/`, `test/**`, `workers/**​/test/`), pulando dirs de build/deps. */
export function countTestFiles(root: string): number {
  let n = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.name.endsWith(".test.ts")) {
        n++;
      }
    }
  };
  walk(root);
  return n;
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
