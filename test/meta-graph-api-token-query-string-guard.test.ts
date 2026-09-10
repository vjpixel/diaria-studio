/**
 * test/meta-graph-api-token-query-string-guard.test.ts (#7893)
 *
 * Guard de REGRESSÃO, não de comportamento de runtime: varre `scripts/` e
 * `workers/` (fonte, não teste/doc) procurando o padrão `access_token=` numa
 * URL da Graph API — o mesmo vazamento que o #7779 corrigiu em
 * `publish-instagram.ts`/`publish-threads.ts`/`delete-test-schedules.ts`/
 * `workers/linkedin-cron/src/dispatch.ts` e o #7893 corrigiu em
 * `meta-capi-staleness.ts`/`ads-campaign-economics-fetch.ts` — reapareceu
 * porque os dois PRs tocaram a mesma API em paralelo na mesma rodada
 * overnight, e o fix de um não se propagou pro outro (achado da Fase 1.5,
 * rodada 260909-260910).
 *
 * Escopo deliberadamente estreito: só o literal `access_token=` fora de
 * `docs/`/`test/` (onde `docs/installation.md` tem um exemplo de `curl`
 * manual, e os testes desta suíte citam o padrão pra provar que NÃO
 * aparece). Não tenta reconhecer toda credencial possível — é um trip-wire
 * barato pro padrão específico que já vazou duas vezes, não uma varredura
 * de segurança geral.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_DIRS = ["scripts", "workers"];
const EXCLUDED_SEGMENTS = new Set(["node_modules", "dist", "test", ".wrangler"]);
const TOKEN_QUERY_PATTERN = /access_token=/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_SEGMENTS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile() && (extname(entry) === ".ts" || extname(entry) === ".js")) {
      if (entry.endsWith(".test.ts")) continue;
      out.push(full);
    }
  }
}

describe("#7893 — nenhum access_token na query string de chamadas à Graph API", () => {
  it("grep de regressão: scripts/ e workers/ nunca contêm o literal access_token=", () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) {
      const abs = join(ROOT, dir);
      try {
        walk(abs, files);
      } catch {
        // diretório pode não existir em checkout parcial — não é o que este
        // guard verifica, segue pros demais.
      }
    }

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (TOKEN_QUERY_PATTERN.test(content)) {
        offenders.push(file.replace(ROOT + "/", ""));
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `access_token= encontrado na query string (fora de test/docs) em: ${offenders.join(", ")} — mover pro header Authorization: Bearer, mesmo padrão do #7779/#7893.`,
    );
  });
});
