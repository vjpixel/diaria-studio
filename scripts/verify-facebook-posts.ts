/**
 * verify-facebook-posts.ts
 *
 * Verifica posts agendados do Facebook contra a Graph API e atualiza
 * `06-social-published.json` com o status real (published / failed).
 *
 * Rationale (#47): `publish-facebook.ts` agenda via `scheduled_publish_time`
 * e grava `status: "scheduled"`. Sem verificação, esse status fica para
 * sempre — mesmo que o post tenha saído (status real: published) ou falhado
 * silenciosamente (ex: token expirado, página sem permissão).
 *
 * Uso:
 *   npx tsx scripts/verify-facebook-posts.ts --edition-dir data/editions/260423/
 *   npm run verify-facebook-posts -- --edition-dir data/editions/260423/
 *
 * Requer: `data/.fb-credentials.json` com `page_access_token` + `api_version`.
 *
 * Output: atualiza in-place o `06-social-published.json` da edição.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// #650 Tier C: PostEntry/SocialPublished agora vêm de scripts/lib/social-published-store.ts
// Re-exports mantidos pra compat com callers (#650 backward compat).
import type { PostEntry, SocialPublished } from "./lib/social-published-store.ts";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
export type { PostEntry, SocialPublished };

/**
 * Pure: resolve canonical path of `06-social-published.json` (#920).
 *
 * `publish-facebook.ts` writes to `_internal/06-social-published.json` (#158
 * canonical convention). Older editions had it in the root. Verify must read
 * from wherever it actually lives — prefer `_internal/`, fall back to root.
 *
 * Returns `null` if neither exists. Exported for tests.
 */
export function resolveSocialPublishedPath(
  rootDir: string,
  editionDir: string,
): string | null {
  const internal = resolve(rootDir, editionDir, "_internal", "06-social-published.json");
  if (existsSync(internal)) return internal;
  const rootLegacy = resolve(rootDir, editionDir, "06-social-published.json");
  if (existsSync(rootLegacy)) return rootLegacy;
  return null;
}

export interface GraphPostResponse {
  /**
   * Inferido (não retornado pela API) — true se created_time presente E
   * (sem scheduled_publish_time OU scheduled_publish_time já passou). #600
   */
  is_published?: boolean;
  created_time?: string;
  permalink_url?: string;
  scheduled_publish_time?: number;
  error?: { message: string; code?: number };
}

export type FetchPostFn = (
  postId: string,
  pageToken: string,
  apiVersion: string,
) => Promise<GraphPostResponse>;

/**
 * Resolve o ID a consultar na Graph API a partir do `fb_post_id` persistido
 * (#3816).
 *
 * `publishPhoto()` (`publish-facebook.ts`) publica via `POST /{pageId}/photos`.
 * Para foto AGENDADA (`published=false` + `scheduled_publish_time`), a
 * resposta só traz `id` — o ID da FOTO — e não traz `post_id` (o ID composto
 * do post de página, `{pageId}_{photoId}`). O fallback `result.post_id ||
 * result.id` em `publish-facebook.ts` grava então o ID cru da foto em
 * `fb_post_id`.
 *
 * Consultar esse ID cru (`GET /{photoId}`) resolve pra um nó `photo`, que não
 * expõe os campos de post de página (`scheduled_publish_time`,
 * `is_published`) — daí o `(#100) Tried accessing nonexisting field`. O ID
 * composto `{pageId}_{photoId}` resolve pro nó `post` correto, com todos os
 * campos disponíveis.
 *
 * Se `fb_post_id` já contém `"_"` (já é o ID composto — `post_id` veio na
 * resposta original, ou é uma edição já gravada no formato correto), usa como
 * está — idempotente, nunca duplica o prefixo. Se `pageId` não estiver
 * disponível, retorna o id original (best-effort — sem `pageId` não dá pra
 * compor, e ler o ID cru é estritamente melhor que não ler nada).
 */
export function resolveGraphPostId(fbPostId: string, pageId: string | undefined): string {
  if (fbPostId.includes("_")) return fbPostId;
  if (!pageId) return fbPostId;
  return `${pageId}_${fbPostId}`;
}

/**
 * Fetch default — chama Graph API real. Pode ser substituído em testes.
 */
/**
 * Infere `is_published` a partir de campos que a Graph API ainda retorna.
 * Pure — testável sem network. (#600)
 *
 * Regra: post está publicado se created_time presente E NÃO está no futuro
 * agendado (scheduled_publish_time ausente OU já passou).
 *
 * #2676 F2: quando `created_time` está ausente MAS `scheduled_publish_time`
 * já passou, isso é o mesmo sinal (post deveria ter saído) — antes essa
 * combinação caía no early-return e ficava com `is_published=undefined`,
 * que `reconcilePost` resolve como `failed` silenciosamente (mesma classe
 * de bug do #600, só que sem a API retornar erro). Sem NENHUM sinal
 * temporal (nem created_time, nem scheduled_publish_time), não há base pra
 * inferir — mantém undefined.
 */
export function inferIsPublished(
  data: GraphPostResponse,
  nowUnix: number,
): GraphPostResponse {
  if (data.error) return data;
  const stillScheduled =
    typeof data.scheduled_publish_time === "number" &&
    data.scheduled_publish_time > nowUnix;
  if (data.created_time) {
    return { ...data, is_published: !stillScheduled };
  }
  if (typeof data.scheduled_publish_time === "number" && !stillScheduled) {
    return { ...data, is_published: true };
  }
  return data;
}

export async function defaultFetchPost(
  postId: string,
  pageToken: string,
  apiVersion: string,
): Promise<GraphPostResponse> {
  // #600: is_published foi deprecated em Graph API v18+ (retorna #100 error).
  // Inferimos publicação por presença de created_time + scheduled_publish_time vencido.
  //
  // #920: permalink_url também retorna #100 em posts agendados (não publicados
  // ainda — sem URL pública). Pedi-lo junto com os outros fields fazia o
  // request inteiro falhar, marcando posts scheduled-OK como `failed`.
  // Estratégia: pedimos só os campos seguros pra determinar status, e
  // tentamos permalink_url num GET separado (best-effort, swallow erros).
  const safeFields = "created_time,scheduled_publish_time";
  const baseUrl = `https://graph.facebook.com/${apiVersion}/${postId}`;
  // Token via Authorization header (não query string) pra evitar leak em logs
  // de proxies/CDNs intermediários — security review da sessão 2026-04-24.
  const headers = { Authorization: `OAuth ${pageToken}` };
  const res = await fetch(`${baseUrl}?fields=${safeFields}`, { headers });
  const data = (await res.json()) as GraphPostResponse;

  // Best-effort permalink_url — só faz sentido pra posts já publicados.
  // Pula a tentativa pra requests com erro ou que ainda estão scheduled no futuro.
  const nowUnix = Math.floor(Date.now() / 1000);
  const stillScheduled =
    typeof data.scheduled_publish_time === "number" &&
    data.scheduled_publish_time > nowUnix;
  if (!data.error && !stillScheduled && data.created_time) {
    try {
      const permRes = await fetch(`${baseUrl}?fields=permalink_url`, { headers });
      if (permRes.ok) {
        const permJson = (await permRes.json()) as { permalink_url?: string };
        if (permJson.permalink_url) {
          data.permalink_url = permJson.permalink_url;
        }
      }
    } catch {
      // permalink_url é metadata cosmético — silenciar falhas.
    }
  }

  return inferIsPublished(data, nowUnix);
}

/**
 * Reconciliação pura: dado o estado atual da entry e o retorno da Graph API,
 * retorna a entry atualizada. Testável sem network.
 */
export function reconcilePost(
  entry: PostEntry,
  graph: GraphPostResponse,
  now: Date,
): PostEntry {
  if (graph.error) {
    // #3816 (3ª recorrência da mesma classe de bug — #600, #920): um erro DE
    // LEITURA (code 100 — "Tried accessing nonexisting field", campo que não
    // existe NAQUELE TIPO DE NÓ) não é evidência de que o post falhou, só de
    // que a verificação ficou cega pro ID que consultou. `graph.error →
    // failed` incondicional transformava essa cegueira em falso negativo: os
    // 3 posts de 260721 foram publicados com sucesso (is_published=true,
    // confirmado ao vivo) mas viraram "failed" porque a leitura usava o ID de
    // foto em vez do ID composto do post (ver resolveGraphPostId acima).
    // Se a entry já tem `fb_post_id` de uma criação bem-sucedida, um erro
    // #100 não deve sobrescrever o status atual — preserva-o (scheduled
    // continua scheduled; failed de uma rodada anterior continua failed até
    // uma leitura conclusiva) e anota a inconclusividade via
    // `verification_note`, pro #573 audit trail e pra um verify seguinte
    // (rodando já com o fix (a)) não achar "nenhuma mudança" e desistir.
    const isReadError = graph.error.code === 100;
    const hasConfirmedCreation =
      typeof entry.fb_post_id === "string" && entry.fb_post_id.length > 0;
    if (isReadError && hasConfirmedCreation) {
      return {
        ...entry,
        verification_note: `read_error_inconclusive_code_100: ${graph.error.message}`,
      };
    }
    return {
      ...entry,
      status: "failed",
      failure_reason: graph.error.message,
      // Limpa uma nota de inconclusividade de uma rodada anterior — esta é
      // agora uma falha real e conclusiva, não deve ficar marcada como
      // "inconclusiva" no audit trail.
      verification_note: undefined,
    };
  }

  const scheduledUnix = graph.scheduled_publish_time;
  const nowUnix = Math.floor(now.getTime() / 1000);

  if (typeof scheduledUnix === "number" && scheduledUnix > nowUnix) {
    // Ainda no futuro. #3816 fix (c): se a entry chegou aqui como "failed"
    // (de uma rodada anterior com erro de leitura — ex: ID de foto em vez do
    // composto), esta leitura CONCLUSIVA confirma que o post está
    // genuinamente agendado — corrige de volta pra "scheduled" em vez de
    // deixar presa em "failed" pra sempre. Único outro status que chega aqui
    // ("scheduled") passa intocado.
    if (entry.status === "failed") {
      return { ...entry, status: "scheduled", failure_reason: undefined, verification_note: undefined };
    }
    return entry;
  }

  if (graph.is_published === true) {
    return {
      ...entry,
      status: "published",
      url: graph.permalink_url ?? entry.url,
      published_at: graph.created_time ?? undefined,
      // Limpa failure_reason de uma rodada "failed" anterior (#3816 fix c) —
      // não deve sobreviver a uma promoção pra published.
      failure_reason: undefined,
      // #2676 F2 self-review: sem `created_time`, este `published` foi inferido
      // só do `scheduled_publish_time` vencido (sem confirmação direta da API
      // de que o post existe). Marca a proveniência pra um audit #573 não ficar
      // cego pra essa diferença de confiança (vs. o caso confirmado por created_time).
      // Atribuição explícita (não spread condicional, #3816): limpa também
      // uma verification_note "read_error_inconclusive_*" de uma rodada
      // anterior quando esta leitura É conclusiva (created_time presente).
      verification_note: graph.created_time
        ? undefined
        : "inferred_from_expired_schedule_no_created_time",
    };
  }

  // scheduled_publish_time passou e is_published !== true → falha silenciosa
  return {
    ...entry,
    status: "failed",
    failure_reason: `scheduled_publish_time passou mas is_published=${graph.is_published ?? "null"}`,
    verification_note: undefined,
  };
}

// #3816 fix (c): entries "failed" com fb_post_id são reconciliáveis — só
// entries criadas com sucesso têm fb_post_id (falhas reais de
// publish-facebook.ts, ex: imagem ausente, scheduled_time_invalid, nunca
// geram um), então "failed" sem fb_post_id continua pulado corretamente logo
// abaixo pelo guard de fbPostId.
const RECONCILABLE_STATUSES = new Set(["scheduled", "failed"]);

export async function verifyPublished(
  published: SocialPublished,
  pageToken: string,
  apiVersion: string,
  fetchPost: FetchPostFn = defaultFetchPost,
  now: Date = new Date(),
  /** #3816 fix (a) — necessário pra compor `{pageId}_{fb_post_id}` na leitura. */
  pageId?: string,
): Promise<{ updated: SocialPublished; changes: number }> {
  const updatedPosts: PostEntry[] = [];
  let changes = 0;

  for (const entry of published.posts) {
    // fb_post_id vem do escape hatch [key: string]: unknown — narrowing manual.
    const fbPostId = entry.fb_post_id;
    if (
      entry.platform !== "facebook" ||
      !RECONCILABLE_STATUSES.has(entry.status) ||
      typeof fbPostId !== "string" ||
      !fbPostId
    ) {
      updatedPosts.push(entry);
      continue;
    }
    try {
      const resolvedId = resolveGraphPostId(fbPostId, pageId);
      const graph = await fetchPost(resolvedId, pageToken, apiVersion);
      const next = reconcilePost(entry, graph, now);
      if (next.status !== entry.status || next.verification_note !== entry.verification_note) {
        changes++;
      }
      updatedPosts.push(next);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      updatedPosts.push({ ...entry, status: "failed", failure_reason: `graph_api_error: ${message}` });
      changes++;
    }
  }

  return { updated: { ...published, posts: updatedPosts }, changes };
}

async function main(): Promise<void> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const editionDir = args["edition-dir"];
  if (!editionDir) {
    console.error("Uso: verify-facebook-posts.ts --edition-dir <path>");
    process.exit(1);
  }

  // #920: prefer _internal/ (canonical, written by publish-facebook.ts), fall
  // back to root (legacy editions). Hardcoding root caused verify to fail when
  // publish-facebook.ts wrote to _internal/ — `Arquivo não encontrado`.
  const publishedPath = resolveSocialPublishedPath(ROOT, editionDir);
  if (!publishedPath) {
    const internal = resolve(ROOT, editionDir, "_internal", "06-social-published.json");
    const root = resolve(ROOT, editionDir, "06-social-published.json");
    console.error(`Arquivo não encontrado em nenhum dos paths esperados:\n  - ${internal}\n  - ${root}`);
    process.exit(1);
  }

  const credsPath = resolve(ROOT, "data/.fb-credentials.json");
  if (!existsSync(credsPath)) {
    console.error(`Credenciais não encontradas: ${credsPath}`);
    process.exit(1);
  }

  const creds = JSON.parse(readFileSync(credsPath, "utf8")) as {
    page_id?: string;
    page_access_token: string;
    api_version: string;
  };
  const published = JSON.parse(readFileSync(publishedPath, "utf8")) as SocialPublished;

  // #3816 fix (a) — mesmo padrão de resolução de publish-facebook.ts: env var
  // tem prioridade, arquivo legacy é fallback. Sem pageId, resolveGraphPostId
  // faz best-effort (usa o fb_post_id cru) — degradação graciosa, não abort.
  const pageId = process.env.FACEBOOK_PAGE_ID || creds.page_id || undefined;

  const { updated, changes } = await verifyPublished(
    published,
    creds.page_access_token,
    creds.api_version,
    defaultFetchPost,
    new Date(),
    pageId,
  );

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
