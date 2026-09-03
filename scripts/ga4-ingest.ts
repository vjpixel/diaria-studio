/**
 * scripts/ga4-ingest.ts (#5248)
 *
 * CLI fino em cima de `scripts/lib/ga4-ingest.ts` (núcleo puro/testável).
 * Roda um relatório básico (usuários ativos, sessões, pageviews por dia,
 * segmentado por canal) na propriedade GA4 `Diaria` (property ID
 * `516813959`, confirmado ao vivo — ver #5248; #5625 corrigiu esta
 * referência — `378028168` é o Account ID, não o Property ID) e salva um
 * snapshot JSON em `data/ga4-snapshots/`.
 *
 * ## Por que snapshot solto em vez de integrar no cac-report.ts
 *
 * `data/aquisicao/spend.csv` (consumido por `cac-report.ts` via
 * `scripts/lib/cac.ts`) é uma tabela de CUSTO por canal/mês — GA4 aqui
 * devolve comportamento pós-clique (sessões/pageviews), uma dimensão
 * diferente que o CAC report não modela ainda. Integrar isso ao relatório
 * de CAC é trabalho futuro (o PR desta issue não decide como) — o
 * snapshot fica em `data/ga4-snapshots/{AAAA-MM-DD}.json`, disponível para
 * quem quiser consumir depois, sem forçar uma decisão de schema agora.
 *
 * ## Fail-soft (mesma disciplina de `google-ads-ingest-spend.ts`, #5237)
 *
 * Sem as env vars `GA4_*`, ou com a chamada falhando por qualquer motivo
 * (rede, auth, quota), este script imprime um aviso e sai com **exit 0** —
 * nunca quebra quem chama.
 *
 * ## Uso
 *
 *   npx tsx scripts/ga4-ingest.ts
 *   npx tsx scripts/ga4-ingest.ts --out data/ga4-snapshots
 *   npx tsx scripts/ga4-ingest.ts --days 7
 *
 * Requer no ambiente (via `doppler run --` ou `.env`): GA4_PROPERTY_ID,
 * GA4_CLIENT_ID, GA4_CLIENT_SECRET, GA4_REFRESH_TOKEN — ver
 * docs/ga4-api-setup.md. **NUNCA aborta se algum faltar** — degrada com o
 * nome da(s) variável(is) ausente(s) no aviso.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { runGa4Ingest, type Ga4AuthConfig, type Ga4RunReportRequest } from "./lib/ga4-ingest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SNAPSHOT_DIR = resolve(ROOT, "data", "ga4-snapshots");

const REQUIRED_ENV_VARS = ["GA4_PROPERTY_ID", "GA4_CLIENT_ID", "GA4_CLIENT_SECRET", "GA4_REFRESH_TOKEN"] as const;

/** Monta a config de auth a partir do ambiente, ou devolve os nomes das
 *  variáveis ausentes — nunca lança. */
function authConfigFromEnv(): { auth: Ga4AuthConfig } | { missing: string[] } {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) return { missing };

  return {
    auth: {
      clientId: process.env.GA4_CLIENT_ID!,
      clientSecret: process.env.GA4_CLIENT_SECRET!,
      refreshToken: process.env.GA4_REFRESH_TOKEN!,
      propertyId: process.env.GA4_PROPERTY_ID!,
    },
  };
}

function fallback(reason: string): void {
  console.warn(`[ga4-ingest] fallback — nenhum snapshot gerado — ${reason}`);
}

export async function main(): Promise<number> {
  const outDir = getStringArg(process.argv.slice(2), "out") ?? DEFAULT_SNAPSHOT_DIR;
  const daysArg = getStringArg(process.argv.slice(2), "days");
  const days = daysArg ? Number(daysArg) : undefined;

  const configResult = authConfigFromEnv();
  if ("missing" in configResult) {
    fallback(
      `variável(is) de ambiente ausente(s): ${configResult.missing.join(", ")}; ` +
        "para ingerir agora use scripts/ga4-sync.ts (autentica por data/.credentials.json)",
    );
    return 0;
  }

  const reportRequest: Ga4RunReportRequest | undefined =
    days && Number.isFinite(days) && days > 0
      ? {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
          dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
          metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }],
          limit: 10000,
        }
      : undefined;

  const result = await runGa4Ingest(fetch, { auth: configResult.auth, reportRequest });

  if (result.kind === "fallback") {
    fallback(result.reason);
    return 0;
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const dateSlug = result.snapshotAt.slice(0, 10); // AAAA-MM-DD
  const snapshotPath = resolve(outDir, `${dateSlug}.json`);
  writeFileSync(
    snapshotPath,
    JSON.stringify({ snapshotAt: result.snapshotAt, propertyId: configResult.auth.propertyId, rows: result.rows }, null, 2),
    "utf8",
  );
  console.log(`[ga4-ingest] ✔ ${snapshotPath} (${result.rows.length} linha(s)).`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      // Último caminho que escaparia como stack cru — nunca deveria chegar
      // aqui (as duas etapas de rede já são fail-soft), mas mantém a
      // disciplina "nunca quebra o caller" mesmo diante de um bug aqui.
      fallback(`erro inesperado: ${e instanceof Error ? e.message : e}`);
      process.exit(0);
    });
}
