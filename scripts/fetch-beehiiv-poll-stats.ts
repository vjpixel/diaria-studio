/**
 * fetch-beehiiv-poll-stats.ts (#107, rewritten in #201)
 *
 * Busca respostas do poll Trivia ("É IA?") embedded num post específico
 * via Beehiiv REST API. Output JSON consumível pelo
 * `compute-eai-poll-stats.ts` via `--responses`.
 *
 * Pipeline:
 *   1. GET post (expand[]=free_web_content) → extrai poll UUIDs do HTML
 *      (poll é referenciado como `https://diaria.beehiiv.com/polls/{uuid}/...`)
 *   2. GET /polls?poll_type=trivia → identifica qual UUID é Trivia
 *      (posts costumam ter 2 polls — Trivia É IA? + voting "como foi?")
 *   3. GET /polls/{id}/responses?expand[]=post (paginado via next_cursor)
 *      → todas as responses (poll é reusado em N posts; cada response carrega
 *      `post_id` que permite atribuição per-edition)
 *   4. Filtra por `post_id == target` → output array
 *      { choice, responded_at(ISO) }
 *
 * Polls Trivia no Beehiiv são reusados em múltiplos posts (`appearances:20`
 * num poll que vimos), portanto filtragem por post_id é obrigatória.
 * Sem `?expand[]=post` o post_id não vem na response.
 *
 * Uso:
 *   npx tsx scripts/fetch-beehiiv-poll-stats.ts \
 *     --post-id <beehiiv-post-id> \
 *     --out <path-to-responses.json>
 *
 * Env requerido:
 *   BEEHIIV_API_KEY         Token Beehiiv (Settings → API)
 *   BEEHIIV_PUBLICATION_ID  ID da publicação (ex: pub_xxx)
 *
 * Output (consumível por compute-eai-poll-stats.ts --responses):
 *   - Array JSON de { choice: string, responded_at: iso-8601 }.
 *
 * Exit codes:
 *   0  Success (com ou sem dados — output é sempre escrito; pode ser [])
 *   1  Args inválidos
 *   2  Erro de API (auth, network, rate limit, post não encontrado)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

interface BeehiivPostContent {
  data?: {
    content?: { free?: { web?: string } };
  };
}

interface BeehiivPoll {
  id: string;
  poll_type?: "voting" | "trivia";
}

interface BeehiivPollListResponse {
  data?: BeehiivPoll[];
  has_more?: boolean;
  next_cursor?: string;
}

interface BeehiivPollResponseItem {
  id: string;
  poll_choice_label?: string;
  created_at?: number;
  post_id?: string;
}

interface BeehiivPollResponsesPage {
  data?: BeehiivPollResponseItem[];
  has_more?: boolean;
  next_cursor?: string;
}

export interface NormalizedResponse {
  choice: string;
  responded_at: string;
}

const POLL_URL_RE = /\/polls\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/**
 * Extrai UUIDs de polls embedded no HTML do post. Beehiiv renderiza polls
 * como `<a href="https://{slug}.beehiiv.com/polls/{uuid}/...">`. Dedupa
 * preservando ordem (primeira ocorrência).
 */
export function extractPollUuidsFromHtml(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of html.matchAll(POLL_URL_RE)) {
    const uuid = match[1].toLowerCase();
    if (!seen.has(uuid)) {
      seen.add(uuid);
      out.push(uuid);
    }
  }
  return out;
}

/**
 * Identifica qual UUID do post é o poll Trivia. Posts costumam ter 2 polls
 * (Trivia É IA? + voting "como foi?"). Retorna o ID com prefixo `poll_`
 * (formato exigido pela API Beehiiv `/polls/{id}/responses`). Aceita o set
 * trivia com ou sem prefixo.
 */
export function pickTriviaPoll(
  postPollUuids: string[],
  triviaPollIds: Set<string>,
): string | null {
  for (const uuid of postPollUuids) {
    const prefixed = `poll_${uuid}`;
    if (triviaPollIds.has(prefixed)) return prefixed;
    if (triviaPollIds.has(uuid)) return prefixed;
  }
  return null;
}

/**
 * Filtra responses pelo post_id alvo (poll é reusado em N posts) e normaliza
 * pra `{ choice, responded_at(ISO) }`. Drops items sem `poll_choice_label`,
 * `post_id` ou `created_at` válidos — defensivo contra shape mudando.
 */
export function filterAndNormalizeResponses(
  responses: BeehiivPollResponseItem[],
  postId: string,
): NormalizedResponse[] {
  const out: NormalizedResponse[] = [];
  for (const r of responses) {
    if (!r.poll_choice_label) continue;
    if (r.post_id !== postId) continue;
    if (typeof r.created_at !== "number" || !Number.isFinite(r.created_at)) continue;
    out.push({
      choice: r.poll_choice_label,
      responded_at: new Date(r.created_at * 1000).toISOString(),
    });
  }
  return out;
}

interface ApiOpts {
  publicationId: string;
  apiKey: string;
  baseUrl?: string;
}

async function fetchJson<T>(url: string, apiKey: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Beehiiv API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function fetchPostHtml(
  postId: string,
  opts: ApiOpts,
): Promise<string> {
  const base = opts.baseUrl ?? "https://api.beehiiv.com/v2";
  const url = `${base}/publications/${opts.publicationId}/posts/${postId}?expand[]=free_web_content`;
  const json = await fetchJson<BeehiivPostContent>(url, opts.apiKey);
  return json.data?.content?.free?.web ?? "";
}

async function fetchTriviaPollIds(opts: ApiOpts): Promise<Set<string>> {
  const base = opts.baseUrl ?? "https://api.beehiiv.com/v2";
  const ids = new Set<string>();
  let cursor: string | undefined;
  // Beehiiv REST ignora `?poll_type=trivia` e `?per_page=100` — paginação
  // é cursor-based com page size fixo de 10. Filtrar trivia client-side.
  while (true) {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const url =
      `${base}/publications/${opts.publicationId}/polls` +
      (params.toString() ? `?${params.toString()}` : "");
    const json = await fetchJson<BeehiivPollListResponse>(url, opts.apiKey);
    for (const p of json.data ?? []) {
      if (p.id && p.poll_type === "trivia") ids.add(p.id.toLowerCase());
    }
    if (!json.has_more || !json.next_cursor) break;
    cursor = json.next_cursor;
  }
  return ids;
}

async function fetchPollResponses(
  pollId: string,
  opts: ApiOpts,
): Promise<BeehiivPollResponseItem[]> {
  const base = opts.baseUrl ?? "https://api.beehiiv.com/v2";
  const all: BeehiivPollResponseItem[] = [];
  let cursor: string | undefined;
  while (true) {
    const params = new URLSearchParams({ per_page: "100" });
    params.append("expand[]", "post");
    if (cursor) params.set("cursor", cursor);
    const url = `${base}/publications/${opts.publicationId}/polls/${pollId}/responses?${params.toString()}`;
    const json = await fetchJson<BeehiivPollResponsesPage>(url, opts.apiKey);
    if (json.data) all.push(...json.data);
    if (!json.has_more || !json.next_cursor) break;
    cursor = json.next_cursor;
  }
  return all;
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
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, "[]\n", "utf8");
    return;
  }

  const apiOpts: ApiOpts = { publicationId, apiKey };

  let html: string;
  let triviaIds: Set<string>;
  try {
    [html, triviaIds] = await Promise.all([
      fetchPostHtml(postId, apiOpts),
      fetchTriviaPollIds(apiOpts),
    ]);
  } catch (e) {
    console.error(
      `[fetch-beehiiv-poll-stats] erro de API: ${(e as Error).message}`,
    );
    process.exit(2);
  }

  const postPollUuids = extractPollUuidsFromHtml(html);
  const triviaPollId = pickTriviaPoll(postPollUuids, triviaIds);

  if (!triviaPollId) {
    console.error(
      `[fetch-beehiiv-poll-stats] nenhum poll trivia encontrado em ${postId} (${postPollUuids.length} polls no HTML)`,
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, "[]\n", "utf8");
    return;
  }

  let responses: BeehiivPollResponseItem[];
  try {
    responses = await fetchPollResponses(triviaPollId, apiOpts);
  } catch (e) {
    console.error(
      `[fetch-beehiiv-poll-stats] erro de API (responses): ${(e as Error).message}`,
    );
    process.exit(2);
  }

  const normalized = filterAndNormalizeResponses(responses, postId);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");

  console.error(
    JSON.stringify(
      {
        post_id: postId,
        trivia_poll_id: triviaPollId,
        total_responses_for_post: normalized.length,
        breakdown_by_choice: normalized.reduce<Record<string, number>>(
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
