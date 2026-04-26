/**
 * fetch-beehiiv-poll-stats.ts (#107)
 *
 * Hit Beehiiv API aggregate-stats endpoint pra extrair stats do Trivia
 * poll de um post publicado. Output JSON consumível pelo
 * `compute-eai-poll-stats.ts` via `--responses`.
 *
 * **Status**: speculative. Trivia stats no aggregate-stats endpoint
 * NÃO foi confirmado em produção (PR #147 prepara o teste — primeira
 * edição com Trivia poll vai validar a hipótese). Este script é
 * defensive: tenta vários shape names possíveis (`polls`, `trivia`,
 * `poll_results`) e degrada gracefully se nenhum match.
 *
 * Uso:
 *   npx tsx scripts/fetch-beehiiv-poll-stats.ts \
 *     --post-id <beehiiv-post-id> \
 *     --out <path-to-responses.json>
 *
 * Env requerido:
 *   BEEHIIV_API_KEY      Token Beehiiv (Settings → API)
 *   BEEHIIV_PUBLICATION_ID  ID da publicação (ex: pub_xxx)
 *
 * Output (consumível por compute-eai-poll-stats.ts --responses):
 *   - JSON array de { choice: string, responded_at?: iso }
 *   - Reconstrói responses sintéticas a partir do breakdown agregado
 *     (ex: 30 votos A + 12 votos B → array com 30 {choice:"A"} e
 *     12 {choice:"B"}). compute-eai-poll-stats só conta — sinal é
 *     equivalente.
 *
 * Exit codes:
 *   0  Success (com ou sem dados de poll — output é sempre escrito)
 *   1  Args inválidos
 *   2  Erro de API (auth, network, rate limit) — diferente de "sem
 *      dados" que sai 0 com array vazio
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

interface BeehiivPollResult {
  // Tentativa 1 (provável): shape com correct/total na raiz do poll
  total_responses?: number;
  correct_responses?: number;
  // Tentativa 2: breakdown por opção
  options?: Array<{ label?: string; votes?: number; correct?: boolean }>;
  // Tentativa 3: legacy
  responses_count?: number;
}

interface BeehiivAggregateStats {
  polls?: BeehiivPollResult[];
  trivia?: BeehiivPollResult[];
  poll_results?: BeehiivPollResult[];
}

export interface NormalizedResponse {
  choice: string;
  responded_at?: string;
}

/**
 * Reconstrói responses sintéticas a partir do breakdown agregado.
 * Não temos timestamps individuais — todos viram `undefined`.
 */
export function expandBreakdownToResponses(
  poll: BeehiivPollResult,
): NormalizedResponse[] {
  if (!poll.options || poll.options.length === 0) return [];
  const out: NormalizedResponse[] = [];
  for (const opt of poll.options) {
    const label = opt.label?.trim();
    const votes = opt.votes ?? 0;
    if (!label || votes <= 0) continue;
    for (let i = 0; i < votes; i++) {
      out.push({ choice: label });
    }
  }
  return out;
}

/**
 * Tenta extrair o primeiro poll/trivia do response em qualquer shape
 * conhecido. Retorna null se nada match.
 */
export function pickFirstPoll(
  stats: BeehiivAggregateStats,
): BeehiivPollResult | null {
  return (
    stats.trivia?.[0] ??
    stats.polls?.[0] ??
    stats.poll_results?.[0] ??
    null
  );
}

interface FetchResult {
  responses: NormalizedResponse[];
  raw_poll: BeehiivPollResult | null;
  api_shape: "trivia" | "polls" | "poll_results" | "none";
}

async function fetchAggregateStats(opts: {
  publicationId: string;
  postId: string;
  apiKey: string;
}): Promise<BeehiivAggregateStats> {
  const url = `https://api.beehiiv.com/v2/publications/${opts.publicationId}/posts/${opts.postId}/aggregate-stats`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Beehiiv API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as BeehiivAggregateStats;
}

export function normalizeStats(stats: BeehiivAggregateStats): FetchResult {
  let apiShape: FetchResult["api_shape"] = "none";
  if (stats.trivia && stats.trivia.length > 0) apiShape = "trivia";
  else if (stats.polls && stats.polls.length > 0) apiShape = "polls";
  else if (stats.poll_results && stats.poll_results.length > 0)
    apiShape = "poll_results";

  const poll = pickFirstPoll(stats);
  const responses = poll ? expandBreakdownToResponses(poll) : [];

  return { responses, raw_poll: poll, api_shape: apiShape };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const postId = args["post-id"];
  const outPath = args.out;
  if (!postId || !outPath) {
    console.error(
      "Uso: fetch-beehiiv-poll-stats.ts --post-id <id> --out <path>",
    );
    process.exit(1);
  }

  const apiKey = process.env.BEEHIIV_API_KEY;
  const publicationId = process.env.BEEHIIV_PUBLICATION_ID;
  if (!apiKey || !publicationId) {
    console.error(
      "[fetch-beehiiv-poll-stats] BEEHIIV_API_KEY ou BEEHIIV_PUBLICATION_ID ausente — skip",
    );
    // Output array vazio + exit 0 (graceful skip — não trava pipeline)
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, "[]\n", "utf8");
    return;
  }

  let stats: BeehiivAggregateStats;
  try {
    stats = await fetchAggregateStats({ publicationId, postId, apiKey });
  } catch (e) {
    console.error(
      `[fetch-beehiiv-poll-stats] erro de API: ${(e as Error).message}`,
    );
    process.exit(2);
  }

  const result = normalizeStats(stats);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result.responses, null, 2) + "\n", "utf8");

  console.error(
    JSON.stringify(
      {
        post_id: postId,
        api_shape: result.api_shape,
        total_responses: result.responses.length,
        breakdown_by_choice: result.responses.reduce<Record<string, number>>(
          (acc, r) => {
            acc[r.choice] = (acc[r.choice] ?? 0) + 1;
            return acc;
          },
          {},
        ),
      },
      null,
      2,
    ),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[fetch-beehiiv-poll-stats] ${(e as Error).message}`);
    process.exit(2);
  });
}
