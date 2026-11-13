/**
 * verify-facebook-posts.ts
 *
 * Verifica posts agendados do Facebook contra a Graph API e atualiza
 * `06-social-published.json` com o status real (published; vencido sem
 * confirmação vira `send_unknown`, e erro de leitura nunca muda o status —
 * #13042).
 *
 * Rationale (#47): `publish-facebook.ts` agenda via `scheduled_publish_time`
 * e grava `status: "scheduled"`. Sem verificação, esse status fica para
 * sempre — mesmo que o post tenha saído (status real: published) ou falhado
 * silenciosamente (ex: token expirado, página sem permissão).
 *
 * Uso:
 *   npx tsx scripts/verify-facebook-posts.ts --edition-dir data/editions/260423/
 *     [--lookback-days N] [--file a.json,b.json] [--extra-stores [--extra-window-days N]]
 *   npm run verify-facebook-posts -- --edition-dir data/editions/260423/
 *
 * #13009: `--lookback-days` confere também as edições anteriores (o Stage 0
 * usa 3: os posts das 15:00/19:00 da edição anterior ainda estão agendados
 * quando ele roda), e `--file`/`--extra-stores` os registros com o mesmo
 * formato fora das edições (semanal, divulgação mensal, anual —
 * `lib/social-reconcile-targets.ts`).
 *
 * Requer: credencial da página de cada entry (#10458) — a `diaria` usa
 * `FACEBOOK_PAGE_ID`/`FACEBOOK_PAGE_ACCESS_TOKEN` (fallback
 * `data/.fb-credentials.json`); as outras, as env vars declaradas em
 * `publishing.social.facebook.pages`. Cada post é lido com o token DA PÁGINA
 * dele; entry de página sem credencial fica intocada (sem token não dá pra
 * saber o estado real — marcar `failed` seria inventar).
 *
 * Output: atualiza in-place o `06-social-published.json` da edição.
 */

// #6166 — mesmo defeito do #6152 (verify-twitter-posts.ts): sem isto, as env
// vars de credencial só existem quando o caller (shell, systemd) já carregou
// o `.env` antes do spawn. Fora do systemd (sessão interativa do editor) elas
// ficam invisíveis e a reconciliação é pulada em silêncio.
import "dotenv/config";

import { readFileSync, existsSync } from "node:fs";
import { basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// #650 Tier C: PostEntry/SocialPublished agora vêm de scripts/lib/social-published-store.ts
// Re-exports mantidos pra compat com callers (#650 backward compat).
import type { PostEntry, SocialPublished } from "./lib/social-published-store.ts";
import { rewriteSocialPosts } from "./lib/social-published-store.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadResolvedFacebookPages, resolveFacebookPageForEntry } from "./lib/facebook-pages.ts"; // #10458
import { editionDir as editionDirPath } from "./lib/edition-paths.ts";
import { discoverExtraSocialStores, lookbackEditions } from "./lib/social-reconcile-targets.ts"; // #13009
export type { PostEntry, SocialPublished };

/**
 * #10458: credencial por entry (página do Facebook). `null` = sem credencial
 * pra página dessa entry → entry fica intocada.
 */
export type FacebookCredentialsForEntry = (entry: PostEntry) => { token: string; pageId?: string } | null;

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
    //
    // #13042 (review P2): vale para QUALQUER erro da Graph, não só o #100. Com
    // o lookback de 3 edições e os registros extras (semanal, divulgação
    // mensal, anual), um erro temporário (rate limit, 5xx, token expirado)
    // que virasse `failed` faria a retomada do publicador repostar um post
    // que pode estar no ar — `failed` fica fora do skip de retomada. Mesmo
    // princípio do #13016: erro de leitura nunca muda o status. O alarme
    // continua: a entry segue `scheduled` vencida (0l "agendado e não
    // publicado") e o main avisa a leitura inconclusiva no stderr.
    const hasConfirmedCreation =
      typeof entry.fb_post_id === "string" && entry.fb_post_id.length > 0;
    if (hasConfirmedCreation) {
      const code = graph.error.code ?? "unknown";
      return {
        ...entry,
        verification_note: `read_error_inconclusive_code_${code}: ${graph.error.message}`,
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
    if (entry.status === "failed" || entry.status === "send_unknown") {
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

  // scheduled_publish_time passou e is_published !== true → publicação não
  // confirmada. #13042 (review P2): `send_unknown`, nunca `failed` — a Graph
  // não provou que o post não saiu, e `failed` uma retomada do publicador
  // (diário, semanal, divulgação mensal) repostaria. Mesmo precedente do
  // `absent_from_feed:` do #13016; o 0l alarma `send_unknown` ("envio
  // ambíguo, conferir o perfil antes de refazer").
  return {
    ...entry,
    status: "send_unknown",
    failure_reason: `${FB_NOT_CONFIRMED_PREFIX} scheduled_publish_time passou mas is_published=${graph.is_published ?? "null"}`,
    verification_note: undefined,
  };
}

/** #13042 — prefixo do `failure_reason` de post vencido que a Graph não confirmou. */
export const FB_NOT_CONFIRMED_PREFIX = "not_confirmed_by_graph:";

// #3816 fix (c): entries "failed" com fb_post_id são reconciliáveis — só
// entries criadas com sucesso têm fb_post_id (falhas reais de
// publish-facebook.ts, ex: imagem ausente, scheduled_time_invalid, nunca
// geram um), então "failed" sem fb_post_id continua pulado corretamente logo
// abaixo pelo guard de fbPostId.
// #13042: `send_unknown` também — uma leitura conclusiva posterior promove a
// `published` (ou devolve a `scheduled`); inconclusiva, preserva.
const RECONCILABLE_STATUSES = new Set(["scheduled", "failed", "send_unknown"]);

export async function verifyPublished(
  published: SocialPublished,
  pageToken: string,
  apiVersion: string,
  fetchPost: FetchPostFn = defaultFetchPost,
  now: Date = new Date(),
  /** #3816 fix (a) — necessário pra compor `{pageId}_{fb_post_id}` na leitura. */
  pageId?: string,
  /**
   * #10458: quando presente, decide token/pageId POR ENTRY (página dela) e
   * sobrepõe `pageToken`/`pageId`. Retorno `null` → entry intocada.
   */
  credentialsFor?: FacebookCredentialsForEntry,
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
    const creds = credentialsFor ? credentialsFor(entry) : { token: pageToken, pageId };
    if (!creds) {
      updatedPosts.push(entry);
      continue;
    }
    try {
      const resolvedId = resolveGraphPostId(fbPostId, creds.pageId);
      const graph = await fetchPost(resolvedId, creds.token, apiVersion);
      const next = reconcilePost(entry, graph, now);
      if (next.status !== entry.status || next.verification_note !== entry.verification_note) {
        changes++;
      }
      updatedPosts.push(next);
    } catch (e: unknown) {
      // #13042 (review P2): erro de rede/Graph ilegível não muda o status
      // (antes virava `failed`, que a retomada do publicador repostaria) —
      // só anota a inconclusividade; o main avisa no stderr.
      const message = e instanceof Error ? e.message : String(e);
      const note = `graph_api_error: ${message}`;
      if (note !== entry.verification_note) changes++;
      updatedPosts.push({ ...entry, verification_note: note });
    }
  }

  return { updated: { ...published, posts: updatedPosts }, changes };
}

/**
 * #13042 — avisos por entry do Facebook que a rodada não conseguiu confirmar:
 * leitura inconclusiva (status preservado) ou vencida sem confirmação
 * (`send_unknown`). Mantém o alarme que o antigo `failed` dava, sem o risco
 * de repost na retomada. @pure
 */
export function facebookVerifyWarnings(posts: PostEntry[]): string[] {
  const out: string[] = [];
  for (const p of posts) {
    if (p.platform !== "facebook") continue;
    const id = `${p.destaque ?? "?"} (fb_post_id ${String(p.fb_post_id ?? "?")})`;
    const note = typeof p.verification_note === "string" ? p.verification_note : "";
    if (note.startsWith("read_error_inconclusive_") || note.startsWith("graph_api_error:")) {
      out.push(`${id}: leitura da Graph inconclusiva, status "${p.status}" preservado — ${note}`);
    } else if (p.status === "send_unknown" && typeof p.failure_reason === "string" && p.failure_reason.startsWith(FB_NOT_CONFIRMED_PREFIX)) {
      out.push(`${id}: publicação não confirmada pela Graph (send_unknown) — conferir a página antes de refazer.`);
    }
  }
  return out;
}

/**
 * #13009 — entrada do Facebook ainda `scheduled` com post id: o que a
 * descoberta de registros extras (`--extra-stores`) procura. @pure
 */
export function isFacebookPendingEntry(entry: PostEntry): boolean {
  return entry.platform === "facebook" && entry.status === "scheduled" && typeof entry.fb_post_id === "string" && !!entry.fb_post_id;
}

/**
 * #13009 — diretórios de edição a verificar: a pedida e as `lookback - 1`
 * anteriores. O Stage 0 roda no dia da edição anterior, quando os posts das
 * 15:00/19:00 dela ainda estão agendados; sem olhar para trás eles ficavam
 * `scheduled` para sempre (286 de 609 no levantamento de 13/11/2026). @pure
 */
export function facebookVerifyEditionDirs(editionDir: string, lookback: number): string[] {
  const aammdd = basename(editionDir.replace(/[\\/]+$/, ""));
  if (lookback <= 1 || !/^\d{6}$/.test(aammdd)) return [editionDir];
  return [editionDir, ...lookbackEditions(aammdd, lookback).slice(1).map((d) => editionDirPath(d))];
}

const USAGE =
  "Uso: verify-facebook-posts.ts [--edition-dir <path> [--lookback-days N]] [--file a.json,b.json] [--extra-stores [--extra-window-days N]]";

async function main(): Promise<number | void> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionDir = values["edition-dir"];
  const files = (values["file"] ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  const extraStores = flags.has("extra-stores");
  if (!editionDir && files.length === 0 && !extraStores) {
    console.error(USAGE);
    return 1;
  }

  const paths: string[] = [];
  if (editionDir) {
    const lookbackRaw = Number(values["lookback-days"]);
    const lookback = Number.isInteger(lookbackRaw) && lookbackRaw > 1 ? lookbackRaw : 1;
    const dirs = facebookVerifyEditionDirs(editionDir, lookback);
    for (const [i, dir] of dirs.entries()) {
      // #920: prefer _internal/ (canonical, written by publish-facebook.ts), fall
      // back to root (legacy editions). Hardcoding root caused verify to fail when
      // publish-facebook.ts wrote to _internal/ — `Arquivo não encontrado`.
      const publishedPath = resolveSocialPublishedPath(ROOT, dir);
      if (publishedPath) {
        paths.push(publishedPath);
        continue;
      }
      if (i > 0) continue; // edição anterior sem registro (feriado, sem social): nada a verificar.
      const internal = resolve(ROOT, dir, "_internal", "06-social-published.json");
      const root = resolve(ROOT, dir, "06-social-published.json");
      console.error(`Arquivo não encontrado em nenhum dos paths esperados:\n  - ${internal}\n  - ${root}`);
      return 1;
    }
  }
  for (const f of files) {
    const p = resolve(ROOT, f);
    if (!existsSync(p)) {
      console.error(`Arquivo não encontrado: ${p}`);
      return 1;
    }
    paths.push(p);
  }
  if (extraStores) {
    const windowRaw = Number(values["extra-window-days"]);
    const windowDays = Number.isFinite(windowRaw) && windowRaw > 0 ? windowRaw : 4;
    const found = discoverExtraSocialStores(resolve(ROOT, "data"), isFacebookPendingEntry, new Date(), windowDays);
    console.log(`registros extras com post do Facebook agendado nos últimos ${windowDays} dia(s): ${found.length}.`);
    for (const f of found) if (!paths.includes(resolve(f))) paths.push(resolve(f));
  }

  // #10458: credencial por página (helper único). A `diaria` mantém a
  // precedência de sempre — env var > data/.fb-credentials.json (#3816 fix a).
  let config: unknown = {};
  try {
    config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  } catch {
    // config ausente/ilegível → fallback de compat do helper (só a `diaria`).
  }
  // `process.env` explícito: o `.env` já foi carregado pelo `dotenv/config` do topo (#6166).
  const { pages, apiVersion } = loadResolvedFacebookPages(ROOT, config, process.env);
  const warned = new Set<string>();
  const credentialsFor: FacebookCredentialsForEntry = (entry) => {
    const res = resolveFacebookPageForEntry(entry, pages);
    if (res.ok) return { token: res.page.token, pageId: res.page.pageId };
    if (!warned.has(res.slug)) {
      warned.add(res.slug);
      console.error(
        `⚠️  página Facebook "${res.slug}": ${res.reason}` +
          ("missing" in res ? ` (faltam: ${res.missing.join(", ")})` : "") +
          " — entries dela ficam sem verificação.",
      );
    }
    return null;
  };

  for (const publishedPath of paths) {
    const published = JSON.parse(readFileSync(publishedPath, "utf8")) as SocialPublished;
    const { updated, changes } = await verifyPublished(
      published,
      "",
      apiVersion,
      defaultFetchPost,
      new Date(),
      undefined,
      credentialsFor,
    );
    for (const w of facebookVerifyWarnings(updated.posts)) console.warn(`⚠️  ${publishedPath}: ${w}`);

    if (changes > 0) {
      // #13009: sob o lock do store, trocando só as entradas do Facebook pelo
      // post id — um publisher concorrente (semanal, mensal) não perde a escrita dele.
      const byId = new Map<string, PostEntry>();
      for (const e of updated.posts) if (e.platform === "facebook" && typeof e.fb_post_id === "string") byId.set(e.fb_post_id, e);
      rewriteSocialPosts(publishedPath, (posts) =>
        posts.map((p) => (p.platform === "facebook" && typeof p.fb_post_id === "string" ? byId.get(p.fb_post_id) ?? p : p)),
      );
      console.log(`✓ ${changes} post(s) atualizados em ${publishedPath}`);
    } else {
      console.log(`Nenhuma mudança de status detectada em ${publishedPath}.`);
    }
  }
  // Sem credencial pra alguma página com post a verificar → exit 1 (antes do
  // #10458 o arquivo de credencial ausente já saía 1; não virar sucesso mudo).
  if (warned.size > 0) return 1;
}

if (isMainModule(import.meta.url)) {
  runCli(main);
}
