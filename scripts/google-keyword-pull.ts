/**
 * google-keyword-pull.ts (#8366)
 *
 * Pull de demanda de busca do Google Ads Keyword Planner (volume mensal no
 * Brasil, competição, termos sugeridos). Miolo: `scripts/lib/google-keyword-planner.ts`.
 *
 * Uso:
 *   npx tsx scripts/google-keyword-pull.ts [--terms "a,b,c"] [--seeds-file seed/keywords.csv] \
 *     [--out data/seo/google-keywords-{YYYY-MM-DD}.json] [--report-out data/seo/google-keywords-{YYYY-MM-DD}.md]
 *
 * `--terms` (lista separada por vírgula) sobrescreve o CSV de sementes — testar
 * hipótese nova não exige commit (#8356). Sem `--terms`, usa `seed/keywords.csv`
 * (mesmas sementes do `bing-pull.ts --mode keywords`). A API aceita 20 sementes
 * por chamada; mais que isso é dividido em lotes e as ideias são unidas.
 *
 * Env: GOOGLE_ADS_{CLIENT_ID,CLIENT_SECRET,REFRESH_TOKEN,DEVELOPER_TOKEN,
 * LOGIN_CUSTOMER_ID,CUSTOMER_ID} (as mesmas do `google-ads-ingest-spend.ts`).
 * Exit: 0 ok; 1 erro de API/credencial; 2 erro de uso.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { refreshGoogleAdsAccessToken, type GoogleAdsAuthConfig } from "./lib/google-ads-ingest.ts";
import {
  fetchKeywordIdeas,
  partitionIdeas,
  renderKeywordReport,
  sortIdeas,
  chunkSeeds,
  dedupeIdeas,
  type KeywordIdea,
} from "./lib/google-keyword-planner.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv();

const REQUIRED_ENV = [
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_CUSTOMER_ID",
] as const;

export function parseSeedsCsv(csv: string): string[] {
  return csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l, i) => l && !(i === 0 && l.toLowerCase() === "term"));
}

export function parseTermsArg(arg: string): string[] {
  return arg.split(",").map((t) => t.trim()).filter(Boolean);
}

async function main(argv: string[]): Promise<number> {
  const { values, flags } = parseArgs(argv);
  if (flags.has("terms") || values.terms === "") {
    console.error("[google-keyword-pull] --terms exige um valor (lista separada por vírgula)");
    return 2;
  }
  const seeds = values.terms
    ? parseTermsArg(values.terms)
    : parseSeedsCsv(readFileSync(resolve(ROOT, values["seeds-file"] ?? "seed/keywords.csv"), "utf8"));
  if (seeds.length === 0) {
    console.error("[google-keyword-pull] nenhum termo (--terms vazio ou CSV sem linhas)");
    return 2;
  }

  const missing = REQUIRED_ENV.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`[google-keyword-pull] env ausente: ${missing.join(", ")}`);
    return 1;
  }
  const auth: GoogleAdsAuthConfig = {
    clientId: process.env.GOOGLE_ADS_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN!,
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID!,
    customerId: process.env.GOOGLE_ADS_CUSTOMER_ID!,
    apiVersion: process.env.GOOGLE_ADS_API_VERSION,
  };

  const token = await refreshGoogleAdsAccessToken(fetch, auth);
  if ("error" in token) {
    console.error(`[google-keyword-pull] ${token.error}`);
    return 1;
  }
  const allIdeas: KeywordIdea[] = [];
  const raws: unknown[] = [];
  for (const batch of chunkSeeds(seeds)) {
    const result = await fetchKeywordIdeas(fetch, auth, token.accessToken, batch);
    if (!result.ok) {
      console.error(`[google-keyword-pull] ${result.error}`);
      return 1;
    }
    allIdeas.push(...result.ideas);
    raws.push(result.raw);
  }
  const ideas = dedupeIdeas(allIdeas);

  const date = new Date().toISOString().slice(0, 10);
  const { kept, discarded, contaminated } = partitionIdeas(ideas, seeds);
  const jsonPath = resolve(ROOT, values.out ?? `data/seo/google-keywords-${date}.json`);
  const mdPath = resolve(ROOT, values["report-out"] ?? `data/seo/google-keywords-${date}.md`);
  for (const p of [jsonPath, mdPath]) mkdirSync(dirname(p), { recursive: true });

  writeFileSync(
    jsonPath,
    JSON.stringify(
      { pulled_at: new Date().toISOString(), seeds, kept: sortIdeas(kept), discarded, contaminated_seeds: contaminated, raw: raws },
      null,
      2,
    ),
  );
  writeFileSync(mdPath, renderKeywordReport({ date, seeds, kept, discarded, contaminated }));
  console.log(`[google-keyword-pull] ${kept.length} ideias relevantes, ${discarded.length} descartadas → ${jsonPath}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((c) => process.exit(c))
    .catch((e) => {
      console.error(`[google-keyword-pull] ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
export { main };
