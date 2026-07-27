/**
 * prep-weekly-twitter.ts (#4101)
 *
 * Análogo a `prep-twitter-posts.ts` (#3994) para o post semanal: a API do X
 * só é alcançável via Buffer MCP (`mcp__claude_ai_Buffer__create_post`), que
 * só existe dentro de uma sessão de agente — não de um script Node puro
 * rodado via Bash. Este script faz só a parte determinística (montagem da
 * thread + gate de config + skip-existing) e devolve, em JSON, a lista exata
 * de tweets que precisam ser postados. O orchestrator/skill posta cada tweet
 * via Buffer MCP (encadeando como reply da thread) e chama
 * `scripts/append-twitter-published.ts --destaque weekly-{n}` pra registrar
 * o resultado.
 *
 * GUARD DE PUBLICAÇÃO: este script NUNCA publica nada — só monta e imprime
 * JSON. O agendamento real (nunca imediato) é responsabilidade do caller via
 * Buffer `create_post` com `scheduledAt` explícito.
 *
 * Uso:
 *   npx tsx scripts/prep-weekly-twitter.ts --saturday 260801 \
 *     [--editions-root data/editions] [--no-skip-existing]
 *
 * Output (stdout, JSON):
 *   { enabled, published_path, tweets: [{ n, text }], reason? }
 *   `tweets` é a lista que o orchestrator deve postar via Buffer MCP, em
 *   ordem (tweets[0] é a abertura da thread).
 */

import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveWeeklyEditionDirs, selectWeeklyD1 } from "./lib/select-weekly-d1.ts";
import { formatTwitterWeeklyThread } from "./lib/format-weekly-social.ts";
import { parseEditionDate } from "./compute-social-schedule.ts";
import { readSocialPublished } from "./lib/social-published-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface WeeklyTwitterPrepResult {
  enabled: boolean;
  published_path: string | null;
  tweets: Array<{ n: number; text: string }>;
  reason?: string;
}

export function prepWeeklyTwitter(opts: {
  saturday: string;
  editionsRoot: string;
  skipExisting: boolean;
}): WeeklyTwitterPrepResult {
  const gateConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const twitterGateConfig = gateConfig?.publishing?.social?.twitter;
  if (twitterGateConfig?.enabled === false) {
    return { enabled: false, published_path: null, tweets: [], reason: "twitter disabled via platform.config.json" };
  }

  const { year, month, day } = parseEditionDate(opts.saturday);
  const saturdayDate = new Date(year, month - 1, day);
  const weekCandidates = resolveWeeklyEditionDirs(saturdayDate, opts.editionsRoot);
  const existingDirs = weekCandidates.filter((c) => c.exists).map((c) => c.dir);
  const items = selectWeeklyD1(existingDirs);

  if (items.length === 0) {
    return { enabled: true, published_path: null, tweets: [], reason: "nenhuma edição válida na semana" };
  }

  mkdirSync(resolve(ROOT, "data", "weekly", opts.saturday), { recursive: true });
  const publishedPath = resolve(ROOT, "data", "weekly", opts.saturday, "06-weekly-published.json");

  const allTweets = formatTwitterWeeklyThread(items);
  const tweets: WeeklyTwitterPrepResult["tweets"] = [];

  if (opts.skipExisting) {
    const published = readSocialPublished(publishedPath);
    const existing = published.posts.find(
      (p) => p.platform === "twitter" && p.destaque === "weekly" && (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
    );
    if (existing) {
      return { enabled: true, published_path: publishedPath, tweets: [], reason: `already ${existing.status}` };
    }
  }

  allTweets.forEach((text, i) => tweets.push({ n: i, text }));

  return { enabled: true, published_path: publishedPath, tweets };
}

function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const saturday = values["saturday"];
  if (!saturday) {
    console.error("ERRO: --saturday AAMMDD é obrigatório.");
    process.exit(1);
  }
  const editionsRoot = resolve(ROOT, values["editions-root"] ?? "data/editions");
  const skipExisting = !flags.has("no-skip-existing");

  try {
    const result = prepWeeklyTwitter({ saturday, editionsRoot, skipExisting });
    console.log(JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
