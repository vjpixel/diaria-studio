/**
 * verify-twitter-posts.ts (#5766)
 *
 * Verifica posts do X/Twitter contra a API GraphQL do Buffer e atualiza
 * `06-social-published.json` com o status real (published / failed).
 *
 * Rationale (#5766, desdobrado da #5762/PR #5756): X/Twitter sai via Buffer
 * (`prep-twitter-posts.ts` + `mcp__claude_ai_Buffer__create_post`, chamado
 * pelo orchestrator dentro de uma sessão de agente — a API do Buffer só é
 * alcançável de lá, não de um script Node puro). `append-twitter-published.ts`
 * grava o status que o `create_post` retornou na hora (`published`/`scheduled`/
 * `draft`/`failed`), mas isso é só confirmação de ENFILEIRAMENTO — LinkedIn,
 * Instagram e Threads já tinham esse mesmo buraco (Facebook e agora Twitter são
 * os únicos com verificação real pós-dispatch, ver #5766/#5775). Uma falha de
 * publicação do lado do Buffer/X (token expirado, mídia rejeitada, rate limit)
 * fica invisível sem isto.
 *
 * Uso:
 *   npx tsx scripts/verify-twitter-posts.ts --edition-dir data/editions/260423/
 *
 * Requer: `BUFFER_ACCESS_TOKEN` no `.env` — Personal Access Token gerado em
 * https://publish.buffer.com/settings/api. Consulta a API GraphQL em
 * https://api.buffer.com/graphql (NÃO a REST legacy `api.bufferapp.com`, que
 * rejeita token pessoal com 401 "Public API tokens are not accepted for REST
 * API access" — confirmado ao vivo na validação deste token, #573).
 *
 * Output: atualiza in-place o `06-social-published.json` da edição.
 */

// #6152 — sem isto, `process.env.BUFFER_ACCESS_TOKEN` só existe quando o
// caller (shell, systemd) já carregou o `.env` antes do spawn. Fora do
// systemd (sessão interativa do editor, `/diaria-edicao` na máquina local)
// o token fica invisível e a reconciliação é pulada em silêncio — mesmo
// com o token presente no `.env`.
import "dotenv/config";

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { PostEntry, SocialPublished } from "./lib/social-published-store.ts";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
export type { PostEntry, SocialPublished };

const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";

const POST_STATUS_QUERY = `
  query VerifyPost($id: PostId!) {
    post(input: { id: $id }) {
      id
      status
      sentAt
      externalLink
      error { message }
    }
  }
`;

export interface BufferPostResponse {
  id?: string;
  status?: "draft" | "error" | "needs_approval" | "scheduled" | "sending" | "sent";
  sentAt?: string | null;
  externalLink?: string | null;
  error?: { message: string } | null;
  /** Erro de nível GraphQL (ex: "Post not found") — não é PostPublishingError. */
  queryError?: string;
}

export type FetchBufferPostFn = (postId: string, token: string) => Promise<BufferPostResponse>;

export async function defaultFetchBufferPost(
  postId: string,
  token: string,
): Promise<BufferPostResponse> {
  const res = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    // Token via Authorization header, nunca query string (mesmo racional de
    // segurança de verify-facebook-posts.ts — evita leak em log de proxy/CDN).
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: POST_STATUS_QUERY, variables: { id: postId } }),
  });
  if (!res.ok) {
    // Erro HTTP-level (401 token expirado, 429 rate limit, 5xx) nunca chega a
    // virar um corpo GraphQL válido — sem este check, cairia no "resposta sem
    // data.post" genérico abaixo, escondendo a causa real (achado do fleet
    // review pré-merge, #5819).
    const text = await res.text().catch(() => "");
    return { queryError: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const body = (await res.json()) as {
    data?: { post?: BufferPostResponse };
    errors?: Array<{ message: string }>;
  };
  if (body.errors && body.errors.length > 0) {
    return { queryError: body.errors.map((e) => e.message).join("; ") };
  }
  return body.data?.post ?? { queryError: "resposta sem data.post" };
}

/**
 * Reconciliação pura: dado o estado atual da entry e o retorno do Buffer,
 * retorna a entry atualizada. Testável sem network.
 *
 * Enum PostStatus do Buffer (confirmado via introspection ao vivo, #573):
 * draft | error | needs_approval | scheduled | sending | sent.
 */
export function reconcileTwitterPost(entry: PostEntry, buffer: BufferPostResponse): PostEntry {
  if (buffer.queryError) {
    // "Post not found" e afins são inconclusivos, não uma falha confirmada —
    // mesmo padrão do code 100 da Graph API em verify-facebook-posts.ts:
    // preserva o status atual e anota a inconclusividade pro #573 audit trail,
    // em vez de declarar "failed" sem evidência.
    return { ...entry, verification_note: `buffer_query_error: ${buffer.queryError}` };
  }

  if (buffer.status === "error") {
    return {
      ...entry,
      status: "failed",
      failure_reason: buffer.error?.message ?? "Buffer reportou status=error sem mensagem",
      verification_note: undefined,
    };
  }

  if (buffer.status === "sent") {
    return {
      ...entry,
      status: "published",
      url: buffer.externalLink ?? entry.url,
      published_at: buffer.sentAt ?? undefined,
      failure_reason: undefined,
      verification_note: undefined,
    };
  }

  // scheduled / sending / needs_approval / draft — ainda não conclusivo,
  // mantém o status atual (nunca regride um "published" já confirmado numa
  // rodada anterior, já que RECONCILABLE_STATUSES abaixo nem chama isto pra
  // entries já "published").
  return entry;
}

const RECONCILABLE_STATUSES = new Set(["scheduled", "draft", "failed"]);

export async function verifyTwitterPublished(
  published: SocialPublished,
  token: string,
  fetchPost: FetchBufferPostFn = defaultFetchBufferPost,
): Promise<{ updated: SocialPublished; changes: number }> {
  const updatedPosts: PostEntry[] = [];
  let changes = 0;

  for (const entry of published.posts) {
    const bufferPostId = entry.buffer_post_id;
    if (
      entry.platform !== "twitter" ||
      !RECONCILABLE_STATUSES.has(entry.status) ||
      typeof bufferPostId !== "string" ||
      !bufferPostId
    ) {
      updatedPosts.push(entry);
      continue;
    }
    try {
      const buffer = await fetchPost(bufferPostId, token);
      const next = reconcileTwitterPost(entry, buffer);
      if (next.status !== entry.status || next.verification_note !== entry.verification_note) {
        changes++;
      }
      updatedPosts.push(next);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      updatedPosts.push({ ...entry, verification_note: `buffer_api_error: ${message}` });
      changes++;
    }
  }

  return { updated: { ...published, posts: updatedPosts }, changes };
}

// #920: mesmo helper de path-resolution de verify-facebook-posts.ts —
// prefere _internal/ (canonical), cai pro root em edições legadas.
export function resolveSocialPublishedPath(rootDir: string, editionDir: string): string | null {
  const internal = resolve(rootDir, editionDir, "_internal", "06-social-published.json");
  if (existsSync(internal)) return internal;
  const rootLegacy = resolve(rootDir, editionDir, "06-social-published.json");
  if (existsSync(rootLegacy)) return rootLegacy;
  return null;
}

async function main(): Promise<void> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const editionDir = args["edition-dir"];
  if (!editionDir) {
    console.error("Uso: verify-twitter-posts.ts --edition-dir <path>");
    process.exit(1);
  }

  const publishedPath = resolveSocialPublishedPath(ROOT, editionDir);
  if (!publishedPath) {
    const internal = resolve(ROOT, editionDir, "_internal", "06-social-published.json");
    const root = resolve(ROOT, editionDir, "06-social-published.json");
    console.error(`Arquivo não encontrado em nenhum dos paths esperados:\n  - ${internal}\n  - ${root}`);
    process.exit(1);
  }

  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) {
    console.error("BUFFER_ACCESS_TOKEN ausente no .env — ver .env.example.");
    process.exit(1);
  }

  const published = JSON.parse(readFileSync(publishedPath, "utf8")) as SocialPublished;

  const { updated, changes } = await verifyTwitterPublished(published, token);

  if (changes > 0) {
    writeFileSync(publishedPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
    console.log(`✓ ${changes} post(s) atualizados em ${publishedPath}`);
  } else {
    console.log("Nenhuma mudança de status detectada.");
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
