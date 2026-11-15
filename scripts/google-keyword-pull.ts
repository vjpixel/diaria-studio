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
 * `--out`/`--report-out` aceitam o token literal `{date}` (trocado pela data do
 * pull) — é assim que a task mensal grava o pull das sementes de vídeo
 * (`seed/video-keywords.csv` → `data/seo/video-keywords-{date}.json`, #13090)
 * com args estáticos.
 *
 * `--trust-seeds` (#13153) desliga o filtro de marca para as SEMENTES do
 * arquivo: nenhuma vira "contaminada", e ideia que contém uma semente inteira
 * fica na tabela mesmo sem marcador de IA ("como usar o gemini no celular").
 * É o modo do pull de vídeo, cujas sementes "como usar o gemini"/"gemini vs
 * claude" o filtro descartaria. O pull de `seed/keywords.csv` roda sem a flag:
 * ele alimenta a descoberta do Stage 1 (#8370) e precisa do filtro inteiro.
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
import { runCli } from "./lib/cli-exit.ts";
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

/** Troca o token literal `{date}` de `--out`/`--report-out` pela data do pull (#13090). */
export function expandDateToken(path: string, date: string): string {
  return path.split("{date}").join(date);
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
  const trustSeeds = flags.has("trust-seeds");
  const { kept, discarded, contaminated } = partitionIdeas(ideas, seeds, { trustSeeds });
  const jsonPath = resolve(ROOT, expandDateToken(values.out ?? `data/seo/google-keywords-${date}.json`, date));
  const mdPath = resolve(ROOT, expandDateToken(values["report-out"] ?? `data/seo/google-keywords-${date}.md`, date));
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
  runCli(() => main(process.argv.slice(2)), {
    onError: (e) => {
      console.error(`[google-keyword-pull] ${e instanceof Error ? e.message : e}`);
    },
  });
}
export { main };
