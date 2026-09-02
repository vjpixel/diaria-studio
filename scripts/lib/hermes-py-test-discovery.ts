/**
 * scripts/lib/hermes-py-test-discovery.ts (#6968)
 *
 * Varredura PURA (recebe já as entradas do filesystem, ou expõe uma versão
 * de I/O fina — ver `findHermesPyTestFiles` abaixo) que localiza todo
 * arquivo `*.test.py` sob uma raiz, recursivamente. Existe pra fechar o
 * buraco medido em #6968: `scripts/run-tests.ts` (o que `npm test` chama)
 * varre `test/**` com `node --test` e NUNCA executa `.test.py` — nenhum
 * workflow do `.github/workflows/` menciona `hermes/`/`python3`. Um
 * `.test.py` co-locado em `hermes/scripts/` é aceito por
 * `hasNewOrModifiedTest` (`scripts/check-pr-bugfix.ts`) como prova de
 * "PR de bugfix tem teste de regressão" (#633/#6863) — mas o CI nunca o
 * roda, então o gate fica satisfeito por algo não verificado.
 *
 * `test/hermes-py-tests.test.ts` é quem consome isto pra rodar CADA
 * `.test.py` descoberto sob `node --test` (opção 2 recomendada pela #6968:
 * um wrapper que DESCOBRE, em vez de um wrapper manual por arquivo —
 * padrão anterior de `test/hermes-model-cost-report-py.test.ts`/#6963,
 * `test/claude-openrouter-symlink-preflight.test.ts`/#6943 — que fecha a
 * classe inteira sem exigir lembrar de criar um wrapper novo a cada
 * `.test.py` futuro).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Injeção pra testabilidade determinística — mesmo racional de
 * `VersionCheckOps`/`SessionDiscoveryOps` nos módulos irmãos de alarme. */
export interface DirScanOps {
  readdirSync: typeof readdirSync;
  statSync: typeof statSync;
}

const defaultOps: DirScanOps = { readdirSync, statSync };

/**
 * Varre `rootDir` recursivamente e devolve o path ABSOLUTO de todo arquivo
 * cujo nome termina em `.test.py`, ordenado (determinístico, independente
 * da ordem que o filesystem devolveu). Diretório ausente/ilegível ->
 * lista vazia (não é erro do discovery em si — quem chama decide se uma
 * lista vazia é suspeita, ver `test/hermes-py-tests.test.ts`, que falha se
 * a varredura real do repo vier vazia).
 */
export function findHermesPyTestFiles(rootDir: string, ops: DirScanOps = defaultOps): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = ops.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = ops.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile() && entry.endsWith(".test.py")) {
        found.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return found.sort();
}
