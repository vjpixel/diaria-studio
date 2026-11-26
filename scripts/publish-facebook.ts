import { facebookCheckpointDiagnostic } from "./lib/facebook-checkpoint.ts";
/**
 * publish-facebook.ts
 *
 * Publica posts no Facebook (d1, d2 — ou d1, d2, d3) via Graph API.
 * #2343: suporta edições com 2 ou 3 destaques.
 * Cada post: imagem + caption. Suporta publicação imediata ou agendada.
 *
 * Uso:
 *   npx tsx scripts/publish-facebook.ts \
 *     --edition-dir data/editions/260422/ \
 *     [--schedule]          # se presente, agenda nos horários de platform.config.json
 *     [--skip-existing]     # pula posts já em 06-social-published.json
 *     [--reschedule]        # modo reschedule: alinha posts existentes ao
 *                           # horário canônico (DELETE + re-publish, idempotente)
 *
 * Resume-aware: lê 06-social-published.json e pula posts facebook já publicados.
 * Append imediato após cada post para proteger contra crash.
 *
 * --reschedule (#123): a Graph API não permite editar `scheduled_publish_time`
 * de posts existentes em apps sem capabilities aprovadas. Workaround oficial:
 * DELETE + re-publish. Este modo lê os posts FB já em 06-social-published.json
 * com status `scheduled`, calcula o horário esperado a partir do config, e pra
 * cada post fora-do-horário deleta + republica. Posts já no horário certo são
 * pulados (idempotente).
 *
 * #10458: publica em TODA página habilitada de
 * `publishing.social.facebook.pages` (helper `scripts/lib/facebook-pages.ts`),
 * mesmo texto e mesmo horário. Idempotência por (página, destaque) — entrada
 * sem `page` é a `diaria`. Falha isolada: página habilitada sem credencial
 * vira warning no resumo e as outras seguem; desabilitada é pulada sem ruído.
 *
 * Output: appends em {edition-dir}/06-social-published.json
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv(); // #923 — carrega .env antes de process.env access

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScheduledAt as computeScheduledAtShared } from "./compute-social-schedule.ts";
import { destaqueScheduledIn, recordDailyRotationFailSoft, useMelhorScheduledIn } from "./lib/social-schedule-rotation-record.ts"; // #10305, #10541
import { appendSocialPosts, PostEntry, RESUME_SKIP_STATUSES, SocialPublished } from "./lib/social-published-store.ts";
import {
  FacebookPublishError,
  fetchForFacebookPublish,
  isAmbiguousHttpStatus,
  lookupFacebookScheduledPost,
  publishFacebookWithReconciliation,
  type FacebookPageLookupResult,
  type FacebookPublishOutcome,
} from "./lib/facebook-publish-retry.ts"; // #14131 — retry sem post duplicado
import {
  DEFAULT_FACEBOOK_PAGE_SLUG,
  applyFacebookPageUtm,
  facebookPageLabel,
  loadResolvedFacebookPages,
  resolvePostPage,
  type ResolvedFacebookPage,
} from "./lib/facebook-pages.ts"; // #10458 — publicar em mais de uma página
import { extractPlatformSection, parseDestaqueHeaders } from "./lint-social-md.ts"; // #2343: reuso de section split + parse de ## dN
import { selectSocialCardImageFile, missingSocialCardReason } from "./lib/select-social-card-image.ts"; // #4090 item 5, #12226
import { extractSection, extractDestaqueBlock, assertNoScaffolding } from "./lib/extract-section.ts"; // #3991 — resolve a seção nova `# Social`; #4309 — extração do `## dN` + guard de scaffolding
import { toSocialPostText } from "./lib/social-post-text.ts"; // #6862 — Facebook não renderiza markdown; #10441 ponto único do texto de post
import { injectChannelLine } from "./lib/social-cta-lines.ts"; // #3991 — injeção determinística da linha de canal no publish
import { USE_MELHOR_POST_ID } from "./lib/use-melhor-post.ts"; // #10451 — linha própria do 4º post, como no Instagram
import { DIARIA_FACEBOOK_PAGE_URL } from "./lib/canonical-urls.ts"; // #2695 fonte única
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts"; // #2834
import { runCli } from "./lib/cli-exit.ts";
import { insertVideoLinkLine } from "./lib/diaria/d1-video-link.ts"; // #10772
import { readD1VideoUrlForPosts as readD1VideoUrl } from "./lib/diaria/d1-video-link-file.ts"; // #10772; no-video.json vence a URL (#12588)
import { resolveCarouselImageUrls } from "./lib/daily-carousel-card.ts"; // #6095 — carrossel diário reusado (Instagram já usa este helper)
import { resolveEditionDirArgOrExit } from "./lib/resolve-edition-dir-arg.ts"; // #9427
import { readResolvedEditionUrl } from "./lib/edition-url.ts"; // #11724 — permalink da edição no 4º post
import {
  USE_MELHOR_COVER_FILE,
  finalizeUseMelhorTextChannelPostText, // #9999
  prependUseMelhorCaptionTitle, // #10201
  planUseMelhorDispatch,
  reportUseMelhorImageFallback,
  reportUseMelhorPlan,
  reportUseMelhorSkip,
  resolveUseMelhorImages,
  summarizeUseMelhor,
  useMelhorDispatchIds,
  type UseMelhorReadyPlan,
} from "./lib/use-melhor-dispatch.ts"; // #9568 — 4º post (USE MELHOR)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * #10772: linha com o link do vídeo do dia no post do D1 — só na página
 * diar.ia.br (decisão do editor; as outras páginas seguem sem o link). Sem URL,
 * outro destaque ou outra página: caption intacta.
 */
export function withD1VideoLink(
  caption: string,
  destaque: string,
  pageSlug: string,
  videoUrl: string | null,
): string {
  if (!videoUrl || destaque !== "d1" || pageSlug !== DEFAULT_FACEBOOK_PAGE_SLUG) return caption;
  return insertVideoLinkLine(caption, videoUrl);
}

/**
 * #2834: migrado pra lib/cli-args.ts. Os 6 flags booleanos abaixo eram
 * checados ANTES do loop genérico no parser local — incondicionais (nunca
 * consomem o próximo token como valor, mesmo que seja um valor não-flag).
 * hasFlag() da lib exigiria o token seguinte ser "--" ou fim do array, o que
 * diverge; preservados via checagem incondicional (argv.includes).
 *
 * #1156: --allow-draft é o caso coberto pelo teste de regressão
 * (test/publish-facebook.test.ts guarda a forma `argv[i] === "--allow-draft"`
 * no source) — preservado via checagem indexada, equivalente a argv.includes.
 * A rodada anterior quebrou este teste ao migrar --allow-draft com hasFlag().
 */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  if (argv.includes("--schedule")) args.schedule = true;
  if (argv.includes("--skip-existing")) args["skip-existing"] = true;
  if (argv.includes("--reschedule")) args.reschedule = true;
  // #1056 — tag entries com is_test:true pra delete-test-schedules safety
  if (argv.includes("--test-mode")) args["test-mode"] = true;
  // #725 bug #2: opt-out explícito do skip default.
  if (argv.includes("--no-skip-existing")) args["no-skip-existing"] = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--allow-draft") {
      // #1156 — opt-in pra criar drafts sem warn (intent claro).
      args["allow-draft"] = true;
      break;
    }
  }
  // #725 bug #4: pares --key value só quando next não é outra flag boolean —
  // reusa a lógica genérica de lib/cli-args.ts (mesma regra do parser local).
  const { values } = parseCliArgs(argv);
  for (const [k, v] of Object.entries(values)) {
    if (!(k in args)) args[k] = v;
  }
  return args;
}

function loadPublished(path: string): SocialPublished {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  return { posts: [] };
}

/**
 * #2343: extrai a lista de destaques presentes na seção de uma plataforma do 03-social.md.
 * Retorna ["d1","d2"] ou ["d1","d2","d3"] conforme a edição. Fallback para ["d1","d2","d3"]
 * se a plataforma não for encontrada ou estiver vazia (mantém comportamento legado).
 * Reusa `extractPlatformSection` de lint-social-md.ts (#2343 review — evita drift de regex).
 *
 * #3991: pra `facebook`/`linkedin`, tenta a seção nova `# Social` (texto único
 * pós-unificação) ANTES do header legado da própria plataforma — fallback de
 * compat com edições publicadas antes deste merge.
 */
export function extractDestaquesFromSocialMd(socialMd: string, platform: string): string[] {
  let section: string | null = null;
  if (platform === "facebook" || platform === "linkedin") {
    section = extractSection(socialMd, "Social") ?? extractPlatformSection(socialMd, platform);
  }
  if (section === null) return ["d1", "d2", "d3"]; // fallback (plataforma ausente)
  const valid = parseDestaqueHeaders(section);
  // Fallback para legado se a seção não tem ao menos 2 destaques bem-formados.
  return valid.length >= 2 ? valid : ["d1", "d2", "d3"];
}

/**
 * #3991: pra `facebook`, tenta a seção nova `# Social` (texto genérico único)
 * ANTES do header legado `# Facebook` — fallback de compat com edições
 * publicadas antes deste merge. Em seguida injeta a linha de CTA do Facebook
 * (`FACEBOOK_CTA_LINE`, e-mail + link, preservado do #602/#3486) no momento
 * do publish, via `injectChannelLine` (`scripts/lib/social-cta-lines.ts`) —
 * nunca em `03-social.md`. Outras plataformas (ex: chamadas de teste com
 * "twitter") seguem o comportamento legado inalterado.
 */
export function extractPostText(
  socialMd: string,
  platform: string,
  destaque: string,
  /** #11724: permalink da edição — no `## um` vira a linha de canal no lugar do CTA de assinatura. */
  editionUrl: string | null = null,
): string {
  // Normalizar CRLF → LF (arquivo pode vir do Drive com Windows line endings)
  socialMd = socialMd.replace(/\r\n/g, '\n');

  let platMatch: RegExpMatchArray | null = null;
  if (platform === "facebook") {
    const socialRe = /(?:^|\n)# Social\n([\s\S]*?)(?=\n# |$)/i;
    platMatch = socialMd.match(socialRe);
  }
  if (!platMatch) {
    // First isolate the platform section (# Facebook or # LinkedIn — legado)
    const platTitle = platform.charAt(0).toUpperCase() + platform.slice(1);
    const platRe = new RegExp(`(?:^|\\n)# ${platTitle}\\n([\\s\\S]*?)(?=\\n# |$)`, "i");
    platMatch = socialMd.match(platRe);
    if (!platMatch) throw new Error(`Platform section '${platTitle}' not found in 03-social.md`);
  }

  // Then extract the destaque subsection
  // #725 bug #3: `## d\d` aceitava `## d10` como `## d1` + `0` no lookahead.
  // `\d+\b` garante match completo de número (2+ dígitos não batem em `d1`).
  // #4309: terminador corrigido via helper compartilhado — o anterior
  // (`\n## d\d+\b`) vazava `## eia`/`## post_pixel` pro `## d3` publicado ao vivo.
  const dText = extractDestaqueBlock(platMatch[1], destaque);
  if (dText === null) throw new Error(`Destaque '${destaque}' not found under '${platform}'`);

  const text =
    platform === "facebook"
      ? injectChannelLine(dText.trim(), "facebook", { useMelhor: destaque === USE_MELHOR_POST_ID, editionUrl })
      : dText.trim();
  assertNoScaffolding(text, `destaque '${destaque}' (${platform})`);
  // #6862: nenhuma plataforma social renderiza markdown — remover `**`/`__`/
  // `*`/`_` aqui, no ponto de publicação, NUNCA na fonte (03-social.md
  // alimenta o carrossel também, que MANTÉM o negrito — ver docstring de
  // lib/strip-markdown-emphasis.ts).
  return toSocialPostText(text);
}

/**
 * #9568: peças do 4º post (item USE MELHOR, `## um`) pro Facebook. Pure —
 * `fileExists` injetável. Mesmo formato dos destaques: carrossel por URL
 * pública quando TODOS os slides do carrossel tipográfico subiram (N slides
 * variável), senão foto única com a capa local (`04-um-carousel-cover-4x5.jpg`).
 * Legenda = `## um` de `# Social` + linha de CTA do Facebook, com
 * `utm_content=usemelhor` no link. Sem texto, ou sem carrossel NEM capa →
 * `{ ok: false }` (o caller pula só o 4º post, sem gravar `failed`).
 */
export function buildUseMelhorFacebookPost(input: {
  socialMd: string;
  plan: UseMelhorReadyPlan;
  images: Record<string, { url?: string }> | undefined;
  editionDir: string;
  /** #11724: permalink da edição (`05-edition-url.txt`); ausente = CTA de assinatura de sempre. */
  editionUrl?: string | null;
  fileExists?: (p: string) => boolean;
}):
  | { ok: true; caption: string; carouselUrls: string[] | null; imageFile: string }
  | { ok: false; reason: string } {
  let caption: string;
  try {
    // #10201: título do item como 1ª linha da legenda.
    caption = prependUseMelhorCaptionTitle(
      finalizeUseMelhorTextChannelPostText(extractPostText(input.socialMd, "facebook", "um", input.editionUrl ?? null)),
      input.plan.captionTitle,
    );
  } catch (e) {
    return { ok: false, reason: `texto '## um' indisponível em '# Social': ${(e as Error).message}` };
  }
  // Corpo vazio: só sobraria a linha de CTA injetada — não publicar.
  if (!extractDestaqueBlock(extractSection(input.socialMd, "Social") ?? "", "um")?.trim()) {
    return { ok: false, reason: "'## um' vazio em '# Social'" };
  }
  const { carouselUrls } = resolveUseMelhorImages(input.images, input.plan);
  // Capa local só vale com carimbo em dia (`plan.slots`) — arte defasada pode ser de outro item.
  const exists = input.fileExists ?? existsSync;
  if (!carouselUrls && !(input.plan.slots && exists(resolve(input.editionDir, USE_MELHOR_COVER_FILE)))) {
    return {
      ok: false,
      reason: input.plan.imageWarning ?? `nem carrossel público completo nem ${USE_MELHOR_COVER_FILE} local`,
    };
  }
  return { ok: true, caption, carouselUrls, imageFile: USE_MELHOR_COVER_FILE };
}

// computeScheduledAt foi movido pra `scripts/compute-social-schedule.ts` (#270)
// pra ser compartilhado entre publish-facebook (Graph API) e publish-linkedin
// (Worker queue + Make webhook). Ambos respeitam o invariante:
// target_date = parse(editionDate) + day_offset, nunca today() + day_offset.
// (import movido pro topo do arquivo em #290)

function computeScheduledAt(
  config: any,
  destaque: string,
  editionDate: string,
  dayOffsetOverride?: number,
  disablePastSlotShift?: boolean
): string {
  return computeScheduledAtShared({
    config,
    editionDate,
    destaque: destaque as "d1" | "d2" | "d3" | "um", // #9568
    platform: "facebook",
    dayOffsetOverride,
    disablePastSlotShift,
  });
}

function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * Valida que `scheduledAt` está no futuro com margem mínima exigida pela
 * Graph API (10 min default). Throws com mensagem acionável se inválido.
 *
 * Introduzido em #78 — bug anterior: se scheduled_publish_time estivesse
 * no passado ou < 10min, publishPhoto silenciosamente publicava imediato
 * em vez de agendar. Validação prévia faz fail-fast.
 */
export function validateScheduledTime(
  scheduledAt: string,
  now: Date = new Date(),
  minOffsetSeconds = 600,
): void {
  const unixTs = Math.floor(new Date(scheduledAt).getTime() / 1000);
  if (isNaN(unixTs)) {
    throw new Error(
      `scheduled_publish_time "${scheduledAt}" é uma data inválida.`,
    );
  }
  const nowUnix = Math.floor(now.getTime() / 1000);
  if (unixTs <= nowUnix) {
    const minsAgo = Math.round((nowUnix - unixTs) / 60);
    throw new Error(
      `scheduled_publish_time ${scheduledAt} já passou (${minsAgo}min atrás). ` +
        `Ajuste publishing.social.fallback_schedule em platform.config.json ou use --day-offset 1.`,
    );
  }
  if (unixTs < nowUnix + minOffsetSeconds) {
    const minsAhead = Math.round((unixTs - nowUnix) / 60);
    const minMins = Math.round(minOffsetSeconds / 60);
    throw new Error(
      `scheduled_publish_time ${scheduledAt} está a ${minsAhead}min de now — ` +
        `Graph API exige margem mínima de ${minMins}min. ` +
        `Aumente --day-offset ou ajuste fallback_schedule.`,
    );
  }
}

/**
 * Compara dois timestamps ISO retornando true se diferem por mais que `toleranceSec`.
 * Pure — exportado pra tests.
 *
 * Usado pelo modo --reschedule (#123): scheduled_at salvo em
 * 06-social-published.json contém offset de timezone, então comparação textual
 * pode dar falso positivo em rodadas adjacentes (mesmo instante representado
 * com offsets diferentes). Convertemos pra Unix ts e comparamos com tolerância.
 */
export function needsReschedule(
  actualISO: string | null,
  expectedISO: string,
  toleranceSec = 60,
): boolean {
  if (!actualISO) return true; // post sem scheduled_at registrado precisa reagendar
  const aTs = Math.floor(new Date(actualISO).getTime() / 1000);
  const eTs = Math.floor(new Date(expectedISO).getTime() / 1000);
  if (isNaN(aTs) || isNaN(eTs)) return true;
  return Math.abs(aTs - eTs) > toleranceSec;
}

/**
 * (#2591) Verifica se um post de canônico-no-passado que já está agendado no
 * futuro (via shift inicial do #2552) deve ser pulado no --reschedule.
 *
 * O agendamento INICIAL grava `scheduled_at` com o valor SHIFTADO (now₀+15min)
 * quando o slot canônico está no passado. O caminho de COMPARAÇÃO usa
 * `canonicalISO` (disablePastSlotShift=true), então a comparação via
 * `needsReschedule(stored, canonical)` sempre difere → churn (#2591).
 *
 * Retorna `true` (pular) quando:
 *   - slot canônico está no passado (<= now), E
 *   - `storedISO` é futuro válido (> now + piso FB de 10min).
 *
 * Retorna `false` (avaliar via needsReschedule) quando:
 *   - slot canônico está no futuro (drift de canônico futuro → reschedule normal), OU
 *   - `storedISO` está no passado (expirou → deve ser reagendado), OU
 *   - `storedISO` é nulo/inválido (needsReschedule cobre este caso).
 *
 * Pure — exportado pra tests.
 */
export function isValidShiftedSchedule(
  canonicalISO: string,
  storedISO: string | null,
  nowMs: number,
  minFutureMs = 10 * 60 * 1000, // 10 min — piso do Facebook Graph API
): boolean {
  if (!storedISO) return false;
  const canonicalMs = Date.parse(canonicalISO);
  const storedMs = Date.parse(storedISO);
  if (isNaN(canonicalMs) || isNaN(storedMs)) return false;
  const canonicalIsInPast = canonicalMs <= nowMs;
  const storedIsValidFuture = storedMs > nowMs + minFutureMs;
  return canonicalIsInPast && storedIsValidFuture;
}

async function deleteFacebookPost(
  pageToken: string,
  apiVersion: string,
  postId: string,
): Promise<void> {
  const url = `https://graph.facebook.com/${apiVersion}/${postId}`;
  const formData = new FormData();
  formData.append("access_token", pageToken);
  const res = await fetch(url, { method: "DELETE", body: formData });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook DELETE HTTP ${res.status}: ${facebookCheckpointDiagnostic(body) ?? body.slice(0, 200)}`);
  }
  const data = await res.json() as { error?: unknown };
  if (data.error) {
    throw new Error(`Facebook DELETE error: ${facebookCheckpointDiagnostic(data) ?? JSON.stringify(data.error)}`);
  }
}

async function publishPhoto(
  pageId: string,
  pageToken: string,
  apiVersion: string,
  imagePath: string,
  caption: string,
  scheduledAt: string | null
): Promise<{ id: string; post_id?: string }> {
  const url = `https://graph.facebook.com/${apiVersion}/${pageId}/photos`;

  const formData = new FormData();
  const imageBuffer = readFileSync(imagePath);
  const blob = new Blob([imageBuffer], { type: "image/jpeg" });
  formData.append("source", blob, "post.jpg");
  formData.append("caption", caption);
  formData.append("access_token", pageToken);

  // Always unpublished — prevents immediate live publication when called without scheduledAt.
  // Timing validation (min 10 min ahead) is the caller's responsibility via validateScheduledTime().
  formData.append("published", "false");
  if (scheduledAt) {
    const unixTs = isoToUnix(scheduledAt);
    formData.append("scheduled_publish_time", String(unixTs));
  }

  // #14131: erro classificado — 5xx/timeout/resposta ilegível é ambíguo (o
  // post pode ter sido criado) e o caller consulta a página antes de repetir.
  const res = await fetchForFacebookPublish(fetch, url, { method: "POST", body: formData }, "Facebook POST /photos");
  return readFacebookCreateResponse(res, "Facebook POST");
}

/**
 * #14131: lê a resposta de um POST que cria o post visível (`/photos` com
 * legenda, `/feed` do carrossel). 4xx e corpo com `error` provam a recusa
 * (`ambiguous: false`); 5xx, JSON ilegível e 2xx sem `id` são ambíguos.
 */
async function readFacebookCreateResponse(res: Response, label: string): Promise<{ id: string; post_id?: string }> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new FacebookPublishError(
      `${label} HTTP ${res.status}: ${facebookCheckpointDiagnostic(body) ?? body.slice(0, 200)}`,
      { ambiguous: isAmbiguousHttpStatus(res.status), httpStatus: res.status },
    );
  }
  let data: { id?: string; post_id?: string; error?: unknown };
  try {
    data = (await res.json()) as { id?: string; post_id?: string; error?: unknown };
  } catch (e) {
    throw new FacebookPublishError(`${label}: resposta ${res.status} ilegível (${e instanceof Error ? e.message : String(e)})`, {
      ambiguous: true,
      httpStatus: res.status,
    });
  }
  if (data.error) {
    throw new FacebookPublishError(`${label} API error: ${facebookCheckpointDiagnostic(data) ?? JSON.stringify(data.error)}`, {
      ambiguous: false,
      httpStatus: res.status,
    });
  }
  if (!data.id && !data.post_id) {
    throw new FacebookPublishError(`${label}: resposta ${res.status} sem id`, { ambiguous: true, httpStatus: res.status });
  }
  return { ...data, id: (data.id ?? data.post_id) as string };
}

/**
 * (#5348) Publica um carrossel MULTI-FOTO no Facebook a partir de URLs
 * públicas — usado pelo carrossel semanal (`publish-weekly-social.ts`), que
 * expandiu do Instagram sozinho pra também publicar no Facebook (mesmo
 * agendamento, decisão do editor 260815). Diferente de `publishPhoto` acima
 * (usada pelo publisher DIÁRIO, que lê um arquivo LOCAL e faz upload do
 * binário via multipart), aqui as imagens já são URLs públicas no CDN (o
 * mesmo carrossel que o Instagram consome via `image_urls`) — a Graph API
 * aceita o parâmetro `url` em `/photos` em vez de `source`, então não
 * precisamos baixar/reupar o binário.
 *
 * Fluxo (padrão documentado da Graph API pra "multi-photo status update",
 * https://developers.facebook.com/docs/graph-api/reference/page/photos/ +
 * https://developers.facebook.com/docs/graph-api/reference/page/feed/#pubfields):
 *   1. N POSTs a `/{page-id}/photos`, cada um com `published=false` e
 *      `url=<imageUrl>` — devolve um `id` de foto SEM criar post visível
 *      nem consumir a quota de posts publicados.
 *   2. 1 POST a `/{page-id}/feed` com `attached_media[i]={"media_fbid":id}`
 *      (um campo de form por índice — a Graph API não aceita um array JSON
 *      único), `message=caption`, `published=false` e
 *      `scheduled_publish_time=<unix>`.
 *
 * Diferente do carrossel do Instagram (#4153) e do Threads (não
 * implementado, #5348), a Graph API do Facebook NÃO precisa de
 * container-status polling — cada `/photos` com `published=false` responde
 * de imediato com o `id` definitivo, pronto pra usar no passo 2.
 *
 * Falha parcial (mesma decisão de escopo do #4153 pro Instagram): se
 * QUALQUER foto falhar no passo 1, o post inteiro é ABORTADO (lança) —
 * nunca publica um carrossel incompleto, porque o texto promete N itens. O
 * CALLER decide o bookkeeping de falha (`status:"failed"` + `reason`), não
 * esta função — mesmo contrato de `publishPhoto` acima.
 */
/**
 * #6095/#6104 — lê 06-public-images.json best-effort para resolver o
 * carrossel diário. Ausência do arquivo OU JSON corrompido nunca lança —
 * ambos degradam pra "sem carrossel" ({}), preservando o contrato
 * tudo-ou-nada de `resolveCarouselImageUrls` e nunca abortando o dispatch.
 */
export function loadPublicImagesFile(publicImagesPath: string): { images?: Record<string, { url?: string }> } {
  if (!existsSync(publicImagesPath)) return {};
  try {
    return JSON.parse(readFileSync(publicImagesPath, "utf8")) as { images?: Record<string, { url?: string }> };
  } catch (e: any) {
    console.warn(`WARN: falha ao parsear ${publicImagesPath} (${e.message}) — seguindo sem carrossel.`);
    return {};
  }
}

export async function publishFacebookCarouselByUrl(
  pageId: string,
  pageToken: string,
  apiVersion: string,
  imageUrls: string[],
  caption: string,
  scheduledAt: string | null,
): Promise<{ id: string; post_id?: string }> {
  const base = `https://graph.facebook.com/${apiVersion}`;

  const photoIds: string[] = [];
  for (const imageUrl of imageUrls) {
    const formData = new FormData();
    formData.append("url", imageUrl);
    formData.append("published", "false");
    formData.append("access_token", pageToken);
    // #14131: foto `published=false` sem legenda não é post visível — falha
    // aqui nunca é ambígua (uma foto órfã não publicada não chega ao leitor).
    let res: Response;
    try {
      res = await fetch(`${base}/${pageId}/photos`, { method: "POST", body: formData });
    } catch (e) {
      throw new FacebookPublishError(`Facebook POST /photos (unpublished, url=${imageUrl}): ${e instanceof Error ? e.message : String(e)}`, { ambiguous: false });
    }
    if (!res.ok) {
      const body = await res.text();
      throw new FacebookPublishError(`Facebook POST /photos (unpublished, url=${imageUrl}) HTTP ${res.status}: ${facebookCheckpointDiagnostic(body) ?? body.slice(0, 200)}`, { ambiguous: false, httpStatus: res.status });
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string; error?: unknown };
    if (data.error) {
      throw new FacebookPublishError(`Facebook /photos error (url=${imageUrl}): ${facebookCheckpointDiagnostic(data) ?? JSON.stringify(data.error)}`, { ambiguous: false });
    }
    if (!data.id) {
      throw new FacebookPublishError(`Facebook /photos sem id (url=${imageUrl})`, { ambiguous: false });
    }
    photoIds.push(data.id);
  }

  const formData = new FormData();
  formData.append("message", caption);
  photoIds.forEach((id, i) => {
    formData.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id }));
  });
  // Sempre unpublished — o scheduling é responsabilidade do caller via
  // scheduledAt (mesmo invariante de publishPhoto acima: nunca publica
  // imediato sem `scheduledAt` explícito).
  formData.append("published", "false");
  formData.append("access_token", pageToken);
  if (scheduledAt) {
    formData.append("scheduled_publish_time", String(isoToUnix(scheduledAt)));
  }

  // #14131: este POST cria o post visível — erro classificado como em publishPhoto.
  const res = await fetchForFacebookPublish(fetch, `${base}/${pageId}/feed`, { method: "POST", body: formData }, `Facebook POST /feed (carrossel, ${photoIds.length} fotos)`);
  return readFacebookCreateResponse(res, `Facebook POST /feed (carrossel, ${photoIds.length} fotos)`);
}

/** #10458: rótulo de log — a página default mantém o formato de sempre (`facebook/d1`). */
export function facebookLogLabel(slug: string, destaque: string): string {
  return facebookPageLabel(slug, destaque);
}

/**
 * Pure (#10458): entrada DESTA página pra este destaque que a retomada não
 * refaz — a chave de idempotência é (platform, page, destaque). Entrada sem
 * `page` é da `diaria` (edições pré-#10458).
 *
 * #14131: além de draft/scheduled, pula `published` e `send_unknown`
 * (`RESUME_SKIP_STATUSES`, #13074) — o post existe ou pode existir na página,
 * e refazer duplica. Só `failed` (nada criado, provado) é refeito.
 */
export function findExistingFacebookPost(
  posts: PostEntry[],
  pageSlug: string,
  destaque: string,
): PostEntry | undefined {
  return posts.find(
    (p) =>
      p.platform === "facebook" &&
      p.destaque === destaque &&
      resolvePostPage(p) === pageSlug &&
      RESUME_SKIP_STATUSES.has(p.status),
  );
}

/** #14131 — instrução de recuperação de um `send_unknown` do Facebook. */
export function sendUnknownFacebookHint(label: string): string {
  return `AVISO ${label}: envio não confirmado (send_unknown). Conferir os posts agendados da página; se o post não existe, trocar o status desta entry para failed em 06-social-published.json e re-rodar (--no-skip-existing refaz TODOS os posts do Facebook e duplicaria os demais).`;
}

/**
 * #14131: um post do Facebook (foto única ou carrossel) com o retry que não
 * duplica — ver `scripts/lib/facebook-publish-retry.ts`. A consulta da página
 * só existe para post agendado (`scheduled_publish_time`): sem agendamento,
 * falha ambígua vira `send_unknown` direto. Nunca lança.
 */
export async function dispatchFacebookPost(input: {
  pageId: string;
  pageToken: string;
  apiVersion: string;
  caption: string;
  scheduledAt: string | null;
  imagePath: string;
  carouselImageUrls: string[] | null;
  label: string;
  /** Injetáveis pra teste (default: espera real). */
  sleep?: (ms: number) => Promise<void>;
  lookupDelayMs?: number;
}): Promise<FacebookPublishOutcome> {
  const { pageId, pageToken, apiVersion, caption, scheduledAt } = input;
  return publishFacebookWithReconciliation({
    label: input.label,
    send: () =>
      input.carouselImageUrls
        ? publishFacebookCarouselByUrl(pageId, pageToken, apiVersion, input.carouselImageUrls, caption, scheduledAt)
        : publishPhoto(pageId, pageToken, apiVersion, input.imagePath, caption, scheduledAt),
    lookup: facebookScheduledPostLookup(pageId, pageToken, apiVersion, caption, scheduledAt),
    sleep: input.sleep,
    lookupDelayMs: input.lookupDelayMs,
  });
}

/**
 * #14131: consulta de `/scheduled_posts` para um post com agendamento; `null`
 * sem agendamento (não há o que consultar — falha ambígua vira `send_unknown`).
 */
function facebookScheduledPostLookup(
  pageId: string,
  pageToken: string,
  apiVersion: string,
  caption: string,
  scheduledAt: string | null,
): (() => Promise<FacebookPageLookupResult>) | null {
  if (!scheduledAt) return null;
  const scheduledUnix = isoToUnix(scheduledAt);
  return () => lookupFacebookScheduledPost({ pageId, pageToken, apiVersion, caption, scheduledUnix });
}

/**
 * #14170: carrossel do Facebook por URL com o mesmo retry sem duplicar de
 * `dispatchFacebookPost` (#14131) — para os publicadores que só postam
 * carrossel (semanal, Retrospectiva). Nunca lança.
 */
export async function dispatchFacebookCarousel(input: {
  pageId: string;
  pageToken: string;
  apiVersion: string;
  caption: string;
  scheduledAt: string | null;
  imageUrls: string[];
  label: string;
  /** Injetáveis pra teste (default: espera real). */
  sleep?: (ms: number) => Promise<void>;
  lookupDelayMs?: number;
}): Promise<FacebookPublishOutcome> {
  const { pageId, pageToken, apiVersion, caption, scheduledAt, imageUrls } = input;
  return publishFacebookWithReconciliation({
    label: input.label,
    send: () => publishFacebookCarouselByUrl(pageId, pageToken, apiVersion, imageUrls, caption, scheduledAt),
    lookup: facebookScheduledPostLookup(pageId, pageToken, apiVersion, caption, scheduledAt),
    sleep: input.sleep,
    lookupDelayMs: input.lookupDelayMs,
  });
}

/**
 * Pure (#14131/#14170): entry do store para o resultado de um post do
 * Facebook. `created` → `scheduled` (ou `draft` sem agendamento), com
 * `recovered` quando o id veio da consulta da página; `failed` (nada criado,
 * provado) e `send_unknown` (o post pode existir) levam o motivo. A retomada
 * pula `send_unknown` e refaz `failed` (`RESUME_SKIP_STATUSES`, #13074).
 */
export function facebookOutcomeEntry(
  outcome: FacebookPublishOutcome,
  ctx: { pageId: string; pageSlug: string; destaque: string; scheduledAt: string | null },
): PostEntry {
  if (outcome.kind === "created") {
    const postId = outcome.result.post_id || outcome.result.id;
    return {
      platform: "facebook",
      page: ctx.pageSlug, // #10458
      destaque: ctx.destaque,
      url: `https://www.facebook.com/${ctx.pageId}/posts/${postId}`,
      status: ctx.scheduledAt ? "scheduled" : "draft",
      scheduled_at: ctx.scheduledAt,
      fb_post_id: postId,
      ...(outcome.recovered && { recovered: outcome.recovered }), // #14131
    };
  }
  return {
    platform: "facebook",
    page: ctx.pageSlug, // #10458
    destaque: ctx.destaque,
    url: null,
    status: outcome.kind,
    scheduled_at: outcome.kind === "send_unknown" ? ctx.scheduledAt : null,
    reason: outcome.reason,
  };
}

export interface FacebookPagePlan {
  /** Habilitadas com credencial completa — recebem o dispatch. */
  publishable: ResolvedFacebookPage[];
  /** Habilitadas SEM credencial — warning no resumo, nunca derrubam as outras. */
  missingCredentials: ResolvedFacebookPage[];
  /** Desabilitadas no config — puladas sem ruído. */
  disabled: string[];
}

/** Pure (#10458): separa as páginas por destino. */
export function planFacebookPages(pages: ResolvedFacebookPage[]): FacebookPagePlan {
  const enabled = pages.filter((p) => p.enabled);
  return {
    publishable: enabled.filter((p) => p.missing.length === 0),
    missingCredentials: enabled.filter((p) => p.missing.length > 0),
    disabled: pages.filter((p) => !p.enabled).map((p) => p.slug),
  };
}

export interface FacebookPageSummary {
  slug: string;
  status: "dispatched" | "missing_credentials" | "disabled";
  /** Env vars ausentes (só `missing_credentials`) — nomes, nunca valores. */
  missing?: string[];
  scheduled?: number;
  draft?: number;
  failed?: number;
}

/**
 * Pure (#10458): resumo por página pro JSON final (o Stage 5 lê daqui o
 * warning de página habilitada sem credencial, sem precisar parsear stderr).
 */
export function pageSummary(plan: FacebookPagePlan, results: PostEntry[]): FacebookPageSummary[] {
  const count = (slug: string, status: string) =>
    results.filter((r) => resolvePostPage(r) === slug && r.status === status).length;
  return [
    ...plan.publishable.map((p) => ({
      slug: p.slug,
      status: "dispatched" as const,
      scheduled: count(p.slug, "scheduled"),
      draft: count(p.slug, "draft"),
      failed: count(p.slug, "failed"),
    })),
    ...plan.missingCredentials.map((p) => ({ slug: p.slug, status: "missing_credentials" as const, missing: p.missing })),
    ...plan.disabled.map((slug) => ({ slug, status: "disabled" as const })),
  ];
}

async function rescheduleFacebookPosts(opts: {
  editionDir: string;
  publishedPath: string;
  socialMd: string;
  editionDate: string;
  config: any;
  /** #10458 — página cujos posts são re-alinhados (credencial + slug + UTM). */
  page: ResolvedFacebookPage;
  apiVersion: string;
  dayOffsetOverride?: number;
  /** #1056 — when true, tag entries com is_test:true */
  isTest?: boolean;
  /**
   * Injetável para testes (#2591). Defaults para `Date.now()`.
   * Usado na checagem "canônico-passado + stored-futuro-válido → skip".
   */
  now?: number;
}): Promise<{ rescheduled: number; skipped: number; failed: number; posts: PostEntry[] }> {
  const published = loadPublished(opts.publishedPath);
  const slug = opts.page.slug;
  // #10458: só os posts DESTA página (sem `page` = diaria) — o token de uma
  // página não deleta post da outra.
  const fbPosts = published.posts.filter(
    (p) => p.platform === "facebook" && p.status === "scheduled" && resolvePostPage(p) === slug,
  );

  if (fbPosts.length === 0) {
    console.error(`Nenhum post Facebook (página ${slug}) agendado em 06-social-published.json. Nada pra reagendar.`);
    return { rescheduled: 0, skipped: 0, failed: 0, posts: [] };
  }

  let rescheduled = 0;
  let skipped = 0;
  let failed = 0;
  const results: PostEntry[] = [];
  const nowMs = opts.now ?? Date.now();
  // Piso mínimo do Facebook Graph API (10min) em ms.
  const FB_MIN_FUTURE_MS = 10 * 60 * 1000;

  for (const existing of fbPosts) {
    const d = existing.destaque;
    // #9568: o 4º post ("um") não é re-alinhado aqui — o reschedule re-sobe a
    // foto local do destaque e não conhece o carrossel/UTM do "um". Mantém o
    // agendamento original; pra mudar, apagar e re-rodar o dispatch normal.
    if (d === "um") {
      console.log(`SKIP ${facebookLogLabel(slug, "um")} (reschedule): 4º post não é re-alinhado por --reschedule (#9568) — agendamento original mantido.`);
      skipped++;
      results.push(existing);
      continue;
    }
    // #2575: usar slot canônico (sem shift) para COMPARAÇÃO de idempotência.
    // O shift só faz sentido no agendamento INICIAL — um slot canônico passado
    // é estável (mesmo valor a cada run), enquanto now+15min avança e gera churn.
    const expectedAt = computeScheduledAt(
      opts.config,
      d,
      opts.editionDate,
      opts.dayOffsetOverride,
      /* disablePastSlotShift */ true,
    );
    // #2575/#2576: para a RE-publicação (após DELETE), usar o slot com shift
    // aplicado (válido/futuro) — o canônico pode estar no passado e seria
    // rejeitado pela Graph API.
    const scheduleAt = computeScheduledAt(
      opts.config,
      d,
      opts.editionDate,
      opts.dayOffsetOverride,
      /* disablePastSlotShift */ false,
    );

    // #2591: fix do fix ineficaz do #2575.
    //
    // Problema: o agendamento INICIAL grava `existing.scheduled_at` com o valor
    // SHIFTADO (now₀+15min) quando o slot canônico está no passado. O caminho de
    // COMPARAÇÃO usa `expectedAt = canônico` (disablePastSlotShift=true), então a
    // comparação real é `shiftado-futuro vs canônico-passado` → sempre difere
    // (>60s) → needsReschedule=true → DELETE + repost a cada --reschedule → churn.
    //
    // Fix: quando o slot canônico está no passado (<= now) E `existing.scheduled_at`
    // já é um futuro válido (> now + piso FB de 10min), o post foi agendado
    // corretamente via shift inicial e NÃO deve ser rescheduleado.
    //
    // Só rescheduleia quando o stored é genuinamente errado:
    //   (a) stored no passado (expirou sem publicar — raro mas possível), OU
    //   (b) slot canônico está no FUTURO e driftou do stored (canônico != stored)
    //
    // (a) + (b) são cobertas por needsReschedule depois desta checagem.
    if (isValidShiftedSchedule(expectedAt, existing.scheduled_at, nowMs, FB_MIN_FUTURE_MS)) {
      console.log(
        `SKIP ${facebookLogLabel(slug, d)} — canônico (${expectedAt}) está no passado mas stored (${existing.scheduled_at}) ` +
        `é futuro válido — agendado corretamente via shift inicial (#2591)`,
      );
      skipped += 1;
      results.push(existing);
      continue;
    }

    if (!needsReschedule(existing.scheduled_at, expectedAt)) {
      console.log(`SKIP ${facebookLogLabel(slug, d)} — já no horário (${existing.scheduled_at})`);
      skipped += 1;
      results.push(existing);
      continue;
    }

    // Validate new time before destruction (avoid losing post if scheduleAt is invalid)
    try {
      validateScheduledTime(scheduleAt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`SKIP ${facebookLogLabel(slug, d)}: scheduled_time_invalid: ${msg}`);
      failed += 1;
      results.push({ ...existing, reason: `scheduled_time_invalid: ${msg}` });
      continue;
    }

    // Re-extract caption + image (in case 03-social.md or images changed since first publish)
    let caption: string;
    try {
      caption = applyFacebookPageUtm(extractPostText(opts.socialMd, "facebook", d), opts.page); // #10458
      caption = withD1VideoLink(caption, d, slug, readD1VideoUrl(opts.editionDir).url); // #10772
    } catch (e: any) {
      console.error(`ERROR re-extracting text for ${facebookLogLabel(slug, d)}: ${e.message}`);
      failed += 1;
      results.push({ ...existing, status: "failed", reason: e.message });
      continue;
    }

    // #4090 self-review: seletor compartilhado (mesmo critério nos 3 call
    // sites). #12226: só o card 4:5, sem fallback pro 1:1 — ausente falha alto.
    const imageFile = selectSocialCardImageFile(opts.editionDir, d);
    const imagePath = resolve(opts.editionDir, imageFile);
    if (!existsSync(imagePath)) {
      const reason = missingSocialCardReason(d);
      console.error(`ERROR: ${reason}`);
      failed += 1;
      results.push({ ...existing, status: "failed", reason });
      continue;
    }

    // DELETE first, then re-publish. If DELETE fails, we don't proceed (would
    // create a duplicate). If re-publish fails after DELETE, log and mark
    // failed — better to know the post is gone than have stale data.
    try {
      console.log(`DELETING ${facebookLogLabel(slug, d)} (was ${existing.scheduled_at}, target ${scheduleAt})...`);
      if (!existing.fb_post_id) {
        throw new Error(`fb_post_id ausente — não dá pra deletar`);
      }
      await deleteFacebookPost(opts.page.token, opts.apiVersion, existing.fb_post_id as string);
    } catch (e: any) {
      console.error(`Failed to delete ${facebookLogLabel(slug, d)}: ${e.message}`);
      failed += 1;
      results.push({ ...existing, reason: `delete_failed: ${e.message}` });
      continue;
    }

    // Re-publish at new time (using scheduleAt which has past-slot shift applied)
    try {
      console.log(`Re-publishing ${facebookLogLabel(slug, d)} at ${scheduleAt}...`);
      const result = await publishPhoto(
        opts.page.pageId,
        opts.page.token,
        opts.apiVersion,
        imagePath,
        caption,
        scheduleAt,
      );
      const postId = result.post_id || result.id;
      const postUrl = `https://www.facebook.com/${opts.page.pageId}/posts/${postId}`;
      const newEntry: PostEntry = {
        platform: "facebook",
        page: slug, // #10458
        destaque: d,
        url: postUrl,
        status: "scheduled",
        scheduled_at: scheduleAt,
        fb_post_id: postId,
      };
      if (opts.isTest) newEntry.is_test = true; // #1056
      appendSocialPosts(opts.publishedPath, [newEntry]);
      rescheduled += 1;
      results.push(newEntry);
      console.log(`OK ${facebookLogLabel(slug, d)} — rescheduled to ${scheduleAt} — ${postUrl}`);
    } catch (e: any) {
      console.error(`Re-publish failed for ${facebookLogLabel(slug, d)}: ${e.message}`);
      const lostEntry: PostEntry = {
        platform: "facebook",
        page: slug, // #10458
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: `delete_succeeded_but_repost_failed: ${e.message}`,
      };
      if (opts.isTest) lostEntry.is_test = true; // #1056
      appendSocialPosts(opts.publishedPath, [lostEntry]);
      failed += 1;
      results.push(lostEntry);
    }
  }

  return { rescheduled, skipped, failed, posts: results };
}

async function main(): Promise<number | void> {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = resolveEditionDirArgOrExit(args["edition-dir"] as string | undefined, { root: ROOT }); // #9427
  const doSchedule = !!args.schedule;
  // #725 bug #2: args["skip-existing"] é true (presente) ou undefined (ausente);
  // `undefined !== false` === true → skipExisting era SEMPRE true independente
  // da flag. Agora lê explicitamente: default true, desligar via --no-skip-existing.
  if (args["skip-existing"]) {
    console.warn("AVISO: --skip-existing não tem efeito (flag legada). Use --no-skip-existing pra desligar o skip.");
  }
  const skipExisting = args["no-skip-existing"] !== true;
  const doReschedule = !!args.reschedule;
  const isTest = !!args["test-mode"]; // #1056 — tag is_test:true em entries
  const dayOffsetOverride = args["day-offset"] ? parseInt(args["day-offset"] as string, 10) : undefined;
  const allowDraft = !!args["allow-draft"]; // #1156 — opt-in pra suprimir warning de draft

  // #1156 — Warning loud quando rodando sem --schedule (cria drafts) e sem opt-in
  // explícito via --allow-draft. Trap recorrente: editor/orchestrator esquece
  // `--schedule`, posts ficam como drafts não publicados em vez de scheduled.
  // (Caso real: Stage 4 test de 260516, 2026-05-12 — 3 drafts criados sem intent,
  // tive que deletar via delete-test-schedules + re-rodar com --schedule.)
  // Em test-mode pula o delay (testes não precisam esperar 3s).
  if (!doSchedule && !doReschedule && !allowDraft) {
    console.error(
      "⚠️  WARN: --schedule ausente. Posts serão criados como DRAFTS (não agendados).\n" +
      "    Se intent era agendar pelo platform.config.json, adicione --schedule.\n" +
      "    Se intent era mesmo draft, opt-in com --allow-draft pra suprimir este aviso.\n" +
      `    (Continuando em ${isTest ? "0" : "3"}s — Ctrl+C pra abortar.)`,
    );
    if (!isTest) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  // Load config
  const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));

  // #10458: páginas do Facebook (lista em publishing.social.facebook.pages,
  // helper único). Env vars com fallback data/.fb-credentials.json (legado,
  // só pra página default). Config de páginas inválido lança (runCli → exit 1).
  const { pages: allPages, apiVersion: api_version } = loadResolvedFacebookPages(ROOT, config);
  const pagePlan = planFacebookPages(allPages);
  for (const slug of pagePlan.disabled) {
    // Desabilitada no config: sem warning (#10458) — só rastro informativo.
    console.log(`INFO facebook[${slug}]: página desabilitada em platform.config.json — pulada.`);
  }
  for (const p of pagePlan.missingCredentials) {
    console.error(
      `⚠️  WARN facebook[${p.slug}]: página habilitada sem credencial (faltam: ${p.missing.join(", ")}). ` +
        "Adicionar em .env — as outras páginas seguem normalmente (#10458).",
    );
  }
  if (pagePlan.publishable.length === 0) {
    const defaultMissing = pagePlan.missingCredentials.find((p) => p.slug === DEFAULT_FACEBOOK_PAGE_SLUG);
    if (defaultMissing) {
      console.error(
        `ERRO: credencial da página ${DEFAULT_FACEBOOK_PAGE_SLUG} incompleta (faltam: ${defaultMissing.missing.join(", ")}).\n` +
          "Adicionar em .env (preferido) ou em data/.fb-credentials.json (legacy).\n" +
          `Page ID: ${DIARIA_FACEBOOK_PAGE_URL} → Sobre → ID da página. Token: https://developers.facebook.com/tools/explorer\n` +
          "(selecionar app + Page Diar.ia → Generate Page Access Token long-lived).",
      );
    } else {
      console.error(
        "ERRO: nenhuma página do Facebook habilitada com credencial completa " +
          "(publishing.social.facebook.pages em platform.config.json, #10458).",
      );
    }
    return 1;
  }

  // Load social content
  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    console.error("ERROR: 03-social.md not found. Run Stage 3 first.");
    return 1;
  }
  const socialMd = readFileSync(socialMdPath, "utf8");

  // Extract edition date from dir name (last 6 chars)
  const editionDate = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop()!;

  // Load/init published state.
  // #158: prefer _internal/ (new convention) but fallback to root for backward
  // compat with editions já-rodadas. Writes always go to _internal/.
  const internalPath = resolve(editionDir, "_internal", "06-social-published.json");
  const rootPath = resolve(editionDir, "06-social-published.json");
  let publishedPath: string;
  if (existsSync(internalPath)) {
    publishedPath = internalPath;
  } else if (existsSync(rootPath)) {
    // Edição antiga: lê da raiz mas grava no _internal/ daqui pra frente
    publishedPath = rootPath;
  } else {
    // Edição nova: cria em _internal/
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
    publishedPath = internalPath;
  }
  // Reschedule mode (#123): align existing scheduled posts to canonical time.
  if (doReschedule) {
    // #10458: cada página re-alinha só os próprios posts, com o próprio token.
    const totals = { rescheduled: 0, skipped: 0, failed: 0 };
    const allPosts: PostEntry[] = [];
    for (const page of pagePlan.publishable) {
      const result = await rescheduleFacebookPosts({
        editionDir,
        publishedPath,
        socialMd,
        editionDate,
        config,
        page,
        apiVersion: api_version,
        dayOffsetOverride,
        isTest,
      });
      totals.rescheduled += result.rescheduled;
      totals.skipped += result.skipped;
      totals.failed += result.failed;
      allPosts.push(...result.posts);
    }
    console.log(
      JSON.stringify(
        {
          mode: "reschedule",
          out_path: publishedPath,
          summary: totals,
          posts: allPosts,
          pages: pageSummary(pagePlan, allPosts),
        },
        null,
        2,
      ),
    );
    return;
  }

  // #6095 — carrossel diário (capa + 3 parágrafos + CTA): lido best-effort,
  // igual ao Threads. Ausência do arquivo/slides nunca é erro — o dispatch
  // diário do Facebook sempre publicou via upload local (`publishPhoto`) e
  // continua funcionando assim quando não há carrossel; só quando os 5
  // slides estão completos é que trocamos pra `publishFacebookCarouselByUrl`
  // (que exige URLs públicas, não arquivo local). Resolvido 1x fora do loop.
  const publicImagesPath = resolve(editionDir, "06-public-images.json");
  const publicImages = loadPublicImagesFile(publicImagesPath);

  // #2343: derive destaque list from actual social MD (supports 2 or 3 destaques).
  const destaques = extractDestaquesFromSocialMd(socialMd, "facebook");
  const results: PostEntry[] = [];

  // #1056 — wrapper que injeta is_test:true em entries quando rodando test_mode
  const tagAndAppend = (entry: PostEntry): void => {
    if (isTest) entry.is_test = true;
    appendSocialPosts(publishedPath, [entry]);
  };

  // #9568: 4º post (USE MELHOR) — entra no MESMO loop como id "um", depois
  // dos destaques, com as peças resolvidas uma vez aqui. Plano não-pronto =
  // nada é adicionado (motivo logado), D1/D2/D3 seguem idênticos.
  const umPlan = planUseMelhorDispatch(editionDir, config);
  reportUseMelhorPlan("facebook", umPlan, { editionId: editionDate, rootDir: ROOT });
  const umPost =
    umPlan.status === "ready"
      ? buildUseMelhorFacebookPost({
          socialMd,
          plan: umPlan,
          images: publicImages.images,
          editionDir,
          editionUrl: readResolvedEditionUrl(editionDir), // #11724
        })
      : null;
  if (umPost && !umPost.ok) reportUseMelhorSkip("facebook", umPost.reason, { editionId: editionDate, rootDir: ROOT });
  if (umPlan.status === "ready" && umPost?.ok) {
    reportUseMelhorImageFallback("facebook", umPlan, resolveUseMelhorImages(publicImages.images, umPlan), {
      editionId: editionDate,
      rootDir: ROOT,
      usesCarousel: true,
    });
  }
  const useMelhorSummary = summarizeUseMelhor(umPlan, umPost);
  const dispatchIds = [...destaques, ...(umPost?.ok ? useMelhorDispatchIds(umPlan) : [])];

  // #10772: URL do vídeo do dia (opcional) pro post do D1 da página diar.ia.br.
  const d1Video = readD1VideoUrl(editionDir);
  if (d1Video.warning) console.warn(`AVISO facebook/d1: ${d1Video.warning}`);

  // #10458: mesma sequência de posts, uma vez por página publicável (mesmo
  // texto + mesmo horário). Falha de uma página fica nas entradas dela.
  for (const page of pagePlan.publishable) {
    for (const d of dispatchIds) {
      // Re-read published state from disk on each iteration (#758): LinkedIn agent
      // may be writing concurrently; always read the latest state under lock.
      const published = loadPublished(publishedPath);

      // Check if already published (skip-existing: ignore failed entries, retry them)
      if (skipExisting) {
        // #10458: chave (platform, page, destaque) — a 2ª página não cai no skip da 1ª.
        const existing = findExistingFacebookPost(published.posts, page.slug, d);
        if (existing) {
          console.log(`SKIP ${facebookLogLabel(page.slug, d)} — already ${existing.status}`);
          if (existing.status === "send_unknown") console.warn(sendUnknownFacebookHint(facebookLogLabel(page.slug, d))); // #14131
          results.push(existing);
          continue;
        }
      }

      // Extract post text
      let caption: string;
      try {
        // #10458: utm_content=page-{slug} nos links do projeto (compõe com usemelhor).
        caption = applyFacebookPageUtm(
          d === "um" && umPost?.ok ? umPost.caption : extractPostText(socialMd, "facebook", d),
          page,
        );
        caption = withD1VideoLink(caption, d, page.slug, d1Video.url); // #10772
      } catch (e: any) {
        console.error(`ERROR extracting text for ${facebookLogLabel(page.slug, d)}: ${e.message}`);
        const entry: PostEntry = {
          platform: "facebook",
          page: page.slug, // #10458
          destaque: d,
          url: null,
          status: "failed",
          scheduled_at: null,
          reason: e.message,
        };
        tagAndAppend(entry);
        results.push(entry);
        continue;
      }

      // #6095 self-review — resolver o carrossel ANTES de checar o arquivo
      // local: a via carrossel usa URLs públicas de 06-public-images.json e
      // não depende do arquivo local single-image, então checar o arquivo
      // local primeiro podia falhar um destaque com carrossel completo por
      // um arquivo que a via carrossel nem usa.
      // #6095 — carrossel diário (capa + 3 parágrafos + CTA) quando os 5
      // slides existem em 06-public-images.json; senão cai pro post de imagem
      // única de sempre (publishPhoto + arquivo local). Tudo-ou-nada via
      // resolveCarouselImageUrls (mesmo helper que o Instagram já usa).
      const isUm = d === "um" && !!umPost?.ok; // #9568
      const carouselImageUrls =
        isUm && umPost?.ok ? umPost.carouselUrls : resolveCarouselImageUrls(publicImages.images, d);

      // Card 4:5 (1080x1350, título embutido) — mesmo critério do Instagram.
      // #12226: sem fallback pro 1:1 (deixou de ser gerado); ausente falha alto.
      // #9568: 4º post usa a capa tipográfica local.
      const imageFile = isUm && umPost?.ok ? umPost.imageFile : selectSocialCardImageFile(editionDir, d);
      const imagePath = resolve(editionDir, imageFile);
      if (!carouselImageUrls && !existsSync(imagePath)) {
        const reason = isUm && umPost?.ok ? `${imageFile} not found` : missingSocialCardReason(d);
        console.error(`ERROR: ${reason}`);
        const entry: PostEntry = {
          platform: "facebook",
          page: page.slug, // #10458
          destaque: d,
          url: null,
          status: "failed",
          scheduled_at: null,
          reason,
        };
        tagAndAppend(entry);
        results.push(entry);
        continue;
      }

      // Determine scheduling
      let scheduledAt: string | null = null;
      if (doSchedule) {
        // #78: pre-schedule validation — fail fast com erro claro em vez de
        // silenciosamente publicar imediato (bug anterior).
        // #9568: o cálculo entrou no try — erro de agendamento (ex.:
        // use_melhor_time inválido pro "um") vira entry failed, não derruba o run.
        try {
          scheduledAt = computeScheduledAt(config, d, editionDate, dayOffsetOverride);
          validateScheduledTime(scheduledAt);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`SKIP ${facebookLogLabel(page.slug, d)}: scheduled_time_invalid: ${msg}`);
          const entry: PostEntry = {
            platform: "facebook",
            page: page.slug, // #10458
            destaque: d,
            url: null,
            status: "failed",
            scheduled_at: scheduledAt,
            reason: `scheduled_time_invalid: ${msg}`,
          };
          tagAndAppend(entry);
          results.push(entry);
          continue;
        }
      }

      // Publish with retry + exponential backoff (#725 bug #10). #14131: o
      // retry nunca repete cego — falha ambígua (5xx/timeout) consulta
      // /scheduled_posts antes de um novo POST (dispatchFacebookPost).
      console.log(
        `Publishing ${facebookLogLabel(page.slug, d)}${carouselImageUrls ? ` (carrossel ${carouselImageUrls.length} fotos)` : ""}...`,
      );
      const outcome = await dispatchFacebookPost({
        pageId: page.pageId,
        pageToken: page.token,
        apiVersion: api_version,
        caption,
        scheduledAt,
        imagePath,
        carouselImageUrls,
        label: facebookLogLabel(page.slug, d),
      });
      const entry = facebookOutcomeEntry(outcome, { pageId: page.pageId, pageSlug: page.slug, destaque: d, scheduledAt });
      if (outcome.kind === "created") {
        tagAndAppend(entry);
        results.push(entry);
        console.log(`OK ${facebookLogLabel(page.slug, d)} — ${entry.status} — ${entry.url}`);
      } else {
        // #14131: `failed` só quando nada foi criado (provado); `send_unknown`
        // quando o post pode existir — a retomada pula este, refaz aquele.
        if (outcome.kind === "send_unknown") {
          console.error(`SEND_UNKNOWN ${facebookLogLabel(page.slug, d)}: ${outcome.reason}`);
          console.warn(sendUnknownFacebookHint(facebookLogLabel(page.slug, d)));
        }
        tagAndAppend(entry);
        results.push(entry);
      }
    }
  }

  // Summary
  const summary = {
    total: results.length,
    draft: results.filter((r) => r.status === "draft").length,
    scheduled: results.filter((r) => r.status === "scheduled").length,
    failed: results.filter((r) => r.status === "failed").length,
    send_unknown: results.filter((r) => r.status === "send_unknown").length, // #14131
  };

  // #10305 (self-review #10417 finding 3): registro do teste rotativo gravado pelo próprio
  // agendamento, não só pelo passo 5c-3d do playbook. Idempotente entre os 4 publicadores; nunca lança.
  // #10427: `um` só entra no registro se este publicador o agendou.
  if (doSchedule) recordDailyRotationFailSoft(ROOT, editionDate, { useMelhorScheduled: useMelhorScheduledIn(results), d3Scheduled: destaqueScheduledIn(results, "d3"), dayOffsetOverride });
  console.log(
    JSON.stringify(
      { out_path: publishedPath, summary, posts: results, use_melhor: useMelhorSummary, pages: pageSummary(pagePlan, results) },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  // #9911: grava process.exitCode em vez de process.exit — no Windows (Node 24) o exit logo após um fetch sai 127.
  runCli(main, { onError: (e) => console.error("Fatal error:", e) });
}
