/**
 * publish-threads.ts (#2479)
 *
 * Publica posts no Threads (d1, d2 — ou d1, d2, d3) via Threads API oficial da Meta.
 * A Threads API é separada da Graph API do Instagram/Facebook: app próprio + token
 * de longa duração + Threads user ID.
 *
 * Fluxo de 2 passos da Threads API:
 *   (1) POST /{threads-user-id}/threads      → cria media container (text + image_url)
 *   (2) POST /{threads-user-id}/threads_publish → publica o container
 *
 * Limite do Threads: 500 chars por post. Sem `--schedule`, se o texto exceder
 * 500 chars, o post é publicado como cadeia (thread): o primeiro post contém
 * os primeiros 500 chars, e os subsequentes encadeiam via reply_to_id —
 * análogo a um thread no Twitter/X.
 *
 * Fonte do texto (#4294, substitui o fallback do #3992): SÓ a seção
 * `# Curto` de 03-social.md (texto único compartilhado com X/Twitter, ≤280
 * chars, escrito por `social-curto`) — cabe inteiro nos 500 chars do Threads
 * sem truncar. **Sem fallback** — mesmo contrato de `prep-twitter-posts.ts`
 * (#3994): destaque ausente ou incompleto em `# Curto` vira skip, nunca um
 * post improvisado a partir de `# Social`/`# Facebook`. O fallback antigo já
 * estava quebrado na prática: procurava `# Facebook`, seção que o #3991
 * colapsou em `# Social`, então o último degrau nem casava mais — e o texto
 * de `# Social`/`# Facebook` nunca carrega o CTA `{edition_url}` do #4285
 * (só `# Curto`, escrito por `social-curto`, tem o placeholder), então o
 * fallback sairia sem link nenhum quando de fato disparasse.
 *
 * Guard não-fatal de conteúdo (#4294, mesmo padrão do #3277): se o texto do
 * post não contiver a URL da edição resolvida (`_internal/05-edition-url.txt`),
 * loga um warn em `data/run-log.jsonl` — nunca bloqueia o dispatch.
 *
 * AGENDAMENTO (#3944 Parte B): a Threads API NÃO tem agendamento nativo —
 * `threads_publish` sempre publica no instante da chamada. `--schedule`
 * enfileira o post no Worker `diaria-linkedin-cron` (mesmo Worker do
 * LinkedIn/Instagram, estendido pra `channel: "threads"`), que dispara no
 * horário exato via Durable Object alarm. **Suporta só posts de 1 chunk
 * (≤500 chars)** — chunking agendado (thread multi-post) não é implementado
 * no Worker: um retry automático no meio do encadeamento duplicaria posts já
 * publicados. Textos maiores falham no enqueue com motivo claro; publique
 * manualmente sem `--schedule` ou encurte o texto.
 *
 * Sem `--schedule` (default): publica imediato, sem passar pelo Worker —
 * comportamento inalterado, com chunking normal pra textos longos.
 *
 * Credenciais (runtime-only):
 *   THREADS_ACCESS_TOKEN — token de longa duração do app Threads da Meta
 *   THREADS_USER_ID      — Threads user ID da conta @diar.ia.br
 *
 * Se as env vars estiverem ausentes, o script encerra com exit 0 (skip gracioso) —
 * Threads é best-effort, não bloqueia outros canais (análogo a publish-instagram.ts).
 *
 * Uso:
 *   npx tsx scripts/publish-threads.ts \
 *     --edition-dir data/editions/260624/ \
 *     [--schedule]          # enfileira no Worker em vez de publicar imediato (#3944 Parte B)
 *     [--skip-existing]     # pula posts já em 06-social-published.json (default: true)
 *     [--no-skip-existing]  # força re-publicação
 *
 * `--schedule` requer o MESMO Worker já usado pelo LinkedIn/Instagram:
 *   DIARIA_LINKEDIN_CRON_URL / DIARIA_LINKEDIN_CRON_TOKEN no env, OU
 *   publishing.social.linkedin.cloudflare_worker_url em platform.config.json
 *   (mesma instância de Worker — não é um Worker separado pro Threads).
 *
 * Resume-aware: lê 06-social-published.json e pula posts threads já publicados.
 * Append imediato após cada post para proteger contra crash.
 *
 * Output: appends em {edition-dir}/_internal/06-social-published.json
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv(); // carrega .env antes de process.env access

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendSocialPosts, PostEntry, SocialPublished } from "./lib/social-published-store.ts";
import { parseDestaqueHeaders } from "./lint-social-md.ts";
import { extractSection, extractDestaqueBlock, assertNoScaffolding } from "./lib/extract-section.ts"; // #2834 fonte única (era duplicada aqui/publish-instagram.ts/lint-social-md.ts); #4309 — extração do `## dN` + guard de scaffolding
import { parseArgs, isMainModule } from "./lib/cli-args.ts"; // #2834 — substitui parseArgs local
import { computeScheduledAt } from "./compute-social-schedule.ts"; // #3944 Parte B — mesmo fallback_schedule usado por LinkedIn/Facebook/Instagram
import { postToWorkerQueue } from "./lib/worker-queue-client.ts"; // #3944 Parte B — cliente HTTP compartilhado com Instagram
import { logEvent } from "./lib/run-log.ts"; // #4294 — guard não-fatal de edition_url ausente
import { tagEditionUrlInText } from "./lib/edition-url.ts"; // #4295 — UTM per-channel na URL já resolvida
import { THREADS_EDITION_UTM } from "./lib/shared/utm-registry.ts"; // #4295
import { resolveCarouselImageUrls } from "./lib/daily-carousel-card.ts"; // #6095 — carrossel diário reusado (Instagram já usa este helper)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const THREADS_API_BASE = "https://graph.threads.net";
const THREADS_API_VERSION = "v1.0";

/** Limite de caracteres por post no Threads. */
export const THREADS_CHAR_LIMIT = 500;

function loadPublished(path: string): SocialPublished {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  return { posts: [] };
}

/**
 * Extrai a lista de destaques da seção `# Curto` do 03-social.md.
 * Sem fallback (#4294, mesmo contrato de `extractDestaquesFromCurto` em
 * `prep-twitter-posts.ts` #3994): se a seção `# Curto` não existe, retorna
 * `[]` — nunca cai pra `# Threads`/`# Facebook`/`# Social`.
 */
export function extractDestaquesFromSocialMd(socialMd: string): string[] {
  const section = extractSection(socialMd, "Curto");
  if (section === null) return [];
  return parseDestaqueHeaders(section);
}

/**
 * Extrai o texto do post `# Curto` para um destaque específico.
 * Retorna `null` se a seção `# Curto` ou o destaque dentro dela não existir
 * — nunca lança nem cai pra outra seção (#4294, mesmo contrato de
 * `extractCurtoText` em `prep-twitter-posts.ts` #3994).
 */
export function extractPostText(socialMd: string, destaque: string): string | null {
  // Normalizar CRLF → LF
  const normalized = socialMd.replace(/\r\n/g, "\n");

  const section = extractSection(normalized, "Curto");
  if (section === null) return null;

  // #4309: terminador corrigido via helper compartilhado (era `\n## d\d+\b`,
  // vazaria seções irmãs não-`## dN` — latente aqui hoje, mas mesma classe do
  // bug ativado em publish-instagram.ts/publish-facebook.ts).
  const dText = extractDestaqueBlock(section, destaque);
  if (dText === null) return null;
  const text = dText.trim();
  assertNoScaffolding(text, `destaque '${destaque}' (threads)`);
  return text;
}

/**
 * Guard não-fatal (#4294, mesmo padrão do guard anti-placeholder #3277): true
 * quando `text` contém `editionUrl` literal. Pure — só string match, exposta
 * pra ser testável sem fixture em disco.
 */
export function textContainsEditionUrl(text: string, editionUrl: string): boolean {
  return text.includes(editionUrl);
}

/**
 * Emite o warning não-fatal (#4294) quando o texto de um post Threads não
 * contém a URL da edição resolvida — stderr + `data/run-log.jsonl` (nível
 * warn, via `logEvent`). NUNCA bloqueia o dispatch — o caller publica o texto
 * mesmo assim. Extraída de `main()` pra ser testável isoladamente, mesmo
 * padrão de `warnUnresolvedPlaceholders` (`resolve-edition-url.ts`, #3277).
 *
 * `rootDir` é repassado a `logEvent` (default `undefined` → cai pro
 * `process.cwd()` de `logEvent`). `main()` sempre passa um root explícito
 * (`ROOT` do repo, ou `--log-root-dir` em teste) pelo mesmo motivo de
 * `resolve-edition-url.ts`: sem isso, testes que spawnam o CLI poluiriam
 * `data/run-log.jsonl` real com edições fictícias.
 */
export function warnMissingEditionUrl(
  destaque: string,
  text: string,
  editionUrl: string,
  editionId: string | null,
  rootDir?: string,
): void {
  console.warn(
    `AVISO (#4294 guard edition_url — não-fatal): texto do Threads (destaque ${destaque}) ` +
      `não contém a URL da edição resolvida (${editionUrl}). O post será publicado mesmo assim.`,
  );
  logEvent(
    {
      edition: editionId,
      stage: 5,
      agent: "publish-threads",
      level: "warn",
      message: `#4294: texto do Threads (destaque ${destaque}) não contém a URL da edição resolvida — dispatch NÃO bloqueado`,
      details: { destaque, edition_url: editionUrl, text_preview: text.slice(0, 120) },
    },
    rootDir,
  );
}

/**
 * Divide um texto longo em chunks de no máximo `maxLen` chars,
 * quebrando em espaços (não no meio de palavras).
 * Retorna lista com 1+ chunks. Se o texto cabe em um único post,
 * retorna `[text]` sem modificação.
 */
export function splitIntoThreadChunks(text: string, maxLen = THREADS_CHAR_LIMIT): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Procurar o último espaço antes do limite
    let cut = remaining.lastIndexOf(" ", maxLen - 1);
    if (cut <= 0) {
      // Sem espaço (ou espaço na posição 0) — cortar no limite duro para
      // evitar chunk vazio quando cut=0.
      cut = maxLen;
    }
    const chunk = remaining.slice(0, cut).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Passo 1: cria media container no Threads.
 * Retorna o container_id para uso no passo 2 (threads_publish).
 *
 * Suporta post de texto puro (sem imagem — Threads API aceita media_type TEXT).
 * Para posts com imagem: adicionar image_url + media_type=IMAGE.
 */
async function createThreadsContainer(
  userId: string,
  accessToken: string,
  text: string,
  replyToId: string | null,
  apiVersion: string,
): Promise<string> {
  const url = `${THREADS_API_BASE}/${apiVersion}/${userId}/threads`;
  const params = new URLSearchParams();
  params.append("media_type", "TEXT");
  params.append("text", text);
  params.append("access_token", accessToken);
  if (replyToId) {
    params.append("reply_to_id", replyToId);
  }

  const res = await fetch(url, { method: "POST", body: params });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Threads /threads HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { id?: string; error?: unknown };
  if (data.error) {
    throw new Error(`Threads /threads API error: ${JSON.stringify(data.error)}`);
  }
  if (!data.id) {
    throw new Error(`Threads /threads response sem id: ${JSON.stringify(data)}`);
  }
  return data.id;
}

/** Intervalo entre polls de status do container, em ms (#3995). */
export const CONTAINER_POLL_INTERVAL_MS = 1000;
/** Máximo de polls antes de desistir e tentar publicar mesmo assim (#3995). */
export const CONTAINER_POLL_MAX_ATTEMPTS = 10;

/**
 * Aguarda o container ficar pronto (`status: FINISHED`) antes de publicar
 * (#3995). Achado na investigação: em 260724, 2 de 3 destaques falharam com
 * `HTTP 400 code=24 subcode=4279009 "Media not found"` no `/threads_publish`
 * chamado LOGO APÓS `createThreadsContainer` retornar um `container_id` —
 * um teste manual mais tarde (mesmo container, mesmo texto) publicou com
 * sucesso, indicando propagação assíncrona do lado da Meta (o container
 * existe mas ainda não está pronto pra ser referenciado por
 * `threads_publish`), não problema de token/permissão.
 *
 * Poll `GET /{container-id}?fields=status,error_message`, mesmo padrão
 * documentado pra containers de mídia da Graph API (Instagram). Timeout
 * limitado ({@link CONTAINER_POLL_MAX_ATTEMPTS} × {@link CONTAINER_POLL_INTERVAL_MS}
 * ≈ 10s) — se esgotar sem `FINISHED`, segue pra `publishThreadsContainer`
 * mesmo assim (best-effort: não é garantido que o polling cubra 100% dos
 * casos, e a chamada de publish já tem sua própria mensagem de erro clara
 * se ainda não estiver pronta). `status: ERROR` aborta cedo com a mensagem
 * da API, sem gastar as tentativas restantes.
 */
export async function waitForContainerReady(
  containerId: string,
  accessToken: string,
  apiVersion: string,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const url = `${THREADS_API_BASE}/${apiVersion}/${containerId}?fields=status,error_message&access_token=${encodeURIComponent(accessToken)}`;
  for (let attempt = 1; attempt <= CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    let status: string | undefined;
    let errorMessage: string | undefined;
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) {
        const data = (await res.json()) as { status?: string; error_message?: string };
        status = data.status;
        errorMessage = data.error_message;
      }
    } catch {
      // Falha de rede no polling — best-effort, tenta de novo até esgotar.
    }
    if (status === "FINISHED") return;
    if (status === "ERROR") {
      throw new Error(`Threads container ${containerId} status=ERROR: ${errorMessage ?? "sem detalhe"}`);
    }
    if (attempt < CONTAINER_POLL_MAX_ATTEMPTS) {
      await sleepFn(CONTAINER_POLL_INTERVAL_MS);
    }
  }
  // Timeout do polling — segue pro publish mesmo assim (best-effort, ver docstring).
}

/**
 * Passo 2: publica o container criado no passo 1.
 * Retorna o media_id do post publicado.
 */
async function publishThreadsContainer(
  userId: string,
  accessToken: string,
  containerId: string,
  apiVersion: string,
): Promise<string> {
  const url = `${THREADS_API_BASE}/${apiVersion}/${userId}/threads_publish`;
  const params = new URLSearchParams();
  params.append("creation_id", containerId);
  params.append("access_token", accessToken);

  const res = await fetch(url, { method: "POST", body: params });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Threads /threads_publish HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { id?: string; error?: unknown };
  if (data.error) {
    throw new Error(`Threads /threads_publish API error: ${JSON.stringify(data.error)}`);
  }
  if (!data.id) {
    throw new Error(`Threads /threads_publish response sem id: ${JSON.stringify(data)}`);
  }
  return data.id;
}

/**
 * Publica um post (possivelmente encadeado) no Threads.
 * Se `chunks.length > 1`, publica o primeiro post e encadeia os restantes
 * via reply_to_id do post publicado anterior.
 *
 * Retorna o media_id do primeiro post (root da thread).
 */
async function publishThread(
  userId: string,
  accessToken: string,
  chunks: string[],
  apiVersion: string,
): Promise<string> {
  let rootMediaId: string | null = null;
  let replyToId: string | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const containerId = await createThreadsContainer(
      userId,
      accessToken,
      chunks[i],
      replyToId,
      apiVersion,
    );
    await waitForContainerReady(containerId, accessToken, apiVersion); // #3995
    const mediaId = await publishThreadsContainer(userId, accessToken, containerId, apiVersion);

    if (i === 0) {
      rootMediaId = mediaId;
      replyToId = mediaId; // próximo post encadeia a partir deste
    } else {
      replyToId = mediaId;
    }
  }

  if (rootMediaId === null) {
    throw new Error("publishThread: chunks array vazio — texto do post não pode ser vazio");
  }
  return rootMediaId;
}

/**
 * Busca o permalink público do post recém-publicado no Threads.
 * Best-effort: se falhar, retorna null (o post foi publicado com sucesso,
 * só não temos o link canônico).
 */
async function fetchThreadsPermalink(
  mediaId: string,
  accessToken: string,
  apiVersion: string,
): Promise<string | null> {
  try {
    const url =
      `${THREADS_API_BASE}/${apiVersion}/${mediaId}` +
      `?fields=permalink&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as { permalink?: string; error?: unknown };
    if (data.error || !data.permalink) return null;
    return data.permalink;
  } catch {
    return null;
  }
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error("ERRO: --edition-dir é obrigatório.");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const skipExisting = !flags.has("no-skip-existing");
  const isTest = flags.has("test-mode");
  const isDryRun = flags.has("dry-run");
  const doSchedule = flags.has("schedule"); // #3944 Parte B
  // #4294 code-review (#3277 pattern): --log-root-dir é override SÓ pra
  // teste — sem ela, o guard de edition_url ausente sempre grava em
  // `{ROOT}/data/run-log.jsonl` (ROOT = raiz do repo, cwd-independente).
  // Testes que spawnam o CLI via subprocess apontam pro próprio tmpdir pra
  // não poluir o log real com warns fabricados.
  const logRootDirArg = values["log-root-dir"];
  const logRootDir = logRootDirArg ? resolve(ROOT, logRootDirArg) : ROOT;

  // #3944 Parte B — mesmo guard de platform.config.json que publish-instagram.ts
  // já tinha: permite ao editor desligar o canal via config (decisão editorial),
  // sem mexer em credenciais. Checar ANTES delas — o canal fica bloqueado até
  // o editor reativar, mesmo com env vars válidas.
  const gateConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const threadsGateConfig = gateConfig?.publishing?.social?.threads;
  if (threadsGateConfig?.enabled === false) {
    console.warn(
      `SKIP: Threads bloqueado via platform.config.json (publishing.social.threads.enabled=false).\n` +
        `Motivo: ${threadsGateConfig.disabled_reason || "não especificado"}\n` +
        "Reative setando publishing.social.threads.enabled:true quando pronto.",
    );
    process.exit(0);
  }

  // #3944 Parte B — Resolver Worker URL/token quando --schedule é passado.
  // Reusa o MESMO Worker do LinkedIn/Instagram (`diaria-linkedin-cron`,
  // generalizado em #3817 e estendido pra `channel: "threads"` aqui) — mesma
  // fila KV, mesmo endpoint /queue, mesmos env vars.
  let workerUrl = "";
  let workerToken = "";
  const platformConfig = gateConfig; // já lido acima pro gate de enabled:false
  if (doSchedule) {
    workerUrl =
      process.env.DIARIA_LINKEDIN_CRON_URL ??
      platformConfig?.publishing?.social?.threads?.cloudflare_worker_url ??
      platformConfig?.publishing?.social?.linkedin?.cloudflare_worker_url ??
      "";
    workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
    // Mesmo fail-fast de publish-instagram.ts (#3817): sem Worker configurado,
    // --schedule não tem pra onde ir — a Threads API não agenda nativo, então
    // não existe fallback de fire-now "que ao menos publica"; abortar é mais
    // seguro que publicar às cegas.
    if (!workerUrl || !workerToken) {
      console.error(
        [
          "ERRO: --schedule passado mas o Cloudflare Worker não está configurado.",
          "  DIARIA_LINKEDIN_CRON_URL: " + (workerUrl ? "set" : "MISSING"),
          "  DIARIA_LINKEDIN_CRON_TOKEN: " + (workerToken ? "set (length=" + workerToken.length + ")" : "MISSING"),
          "",
          "A Threads API não agenda nativamente (#3944 Parte B) — sem o Worker",
          "não há como agendar. Resolução:",
          "  1. Confirmar .env com DIARIA_LINKEDIN_CRON_TOKEN",
          "  2. Confirmar platform.config.json (ou env DIARIA_LINKEDIN_CRON_URL)",
          "     com cloudflare_worker_url em publishing.social.linkedin (ou .threads)",
          "  3. OU rodar SEM --schedule pra publicar imediatamente conscientemente",
        ].join("\n"),
      );
      process.exit(2);
    }
  }

  // Carregar credenciais — env vars obrigatórias em runtime
  const threadsUserId = process.env.THREADS_USER_ID || "";
  const accessToken = process.env.THREADS_ACCESS_TOKEN || "";
  const apiVersion = process.env.THREADS_API_VERSION || THREADS_API_VERSION;

  // Best-effort: se creds ausentes, skip gracioso (exit 0, não exit 1).
  // Threads é dispatch best-effort — análogo a publish-instagram.ts (#2486).
  // Exit 1 mascararia violations de consent de LinkedIn/Facebook nos outros canais.
  if (!threadsUserId || !accessToken) {
    const missing = [
      !threadsUserId && "THREADS_USER_ID",
      !accessToken && "THREADS_ACCESS_TOKEN",
    ]
      .filter(Boolean)
      .join(", ");
    console.warn(
      `SKIP: ${missing} ausente(s) — Threads não publicado nesta edição.\n` +
        "Configure em .env para habilitar o Threads.\n" +
        "  THREADS_USER_ID: Threads user ID da conta @diar.ia.br\n" +
        "  THREADS_ACCESS_TOKEN: token de longa duração do app Threads da Meta",
    );
    process.exit(0);
  }

  // Carregar social content
  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    console.error("ERROR: 03-social.md não encontrado. Rode Stage 2 primeiro.");
    process.exit(1);
  }
  const socialMd = readFileSync(socialMdPath, "utf8");

  // Extrair data da edição do nome do diretório (#3944 Parte B — mesmo
  // padrão de publish-instagram.ts, usado por computeScheduledAt no modo --schedule).
  const editionDate = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop()!;

  // Resolver path do arquivo de publicações
  const internalPath = resolve(editionDir, "_internal", "06-social-published.json");
  const rootPath = resolve(editionDir, "06-social-published.json");
  let publishedPath: string;
  if (existsSync(internalPath)) {
    publishedPath = internalPath;
  } else if (existsSync(rootPath)) {
    publishedPath = rootPath;
  } else {
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
    publishedPath = internalPath;
  }

  // #6095 — carrossel diário (capa + 3 parágrafos + CTA): lido best-effort,
  // igual ao Facebook (Threads daily não exigia imagem antes, então ausência
  // do arquivo/slides nunca é erro — só significa "sem carrossel", mesmo
  // comportamento de hoje). Resolvido 1x fora do loop (não muda por destaque).
  const publicImagesPath = resolve(editionDir, "06-public-images.json");
  const publicImages: { images?: Record<string, { url?: string }> } = existsSync(publicImagesPath)
    ? (JSON.parse(readFileSync(publicImagesPath, "utf8")) as { images?: Record<string, { url?: string }> })
    : {};

  // Extrair destaques da seção '# Curto' — sem fallback (#4294)
  const destaques = extractDestaquesFromSocialMd(socialMd);
  const results: PostEntry[] = [];
  let skippedCount = 0;
  // #4294 — destaques que viraram skip por ausência/incompletude em '# Curto'
  // (distinto de skippedCount, que também conta "já publicado" via resume).
  const skippedNoCurto: Array<{ destaque: string; reason: string }> = [];
  // #4294 — guard não-fatal de edition_url ausente no texto (ver loop abaixo).
  const editionUrlFile = resolve(editionDir, "_internal", "05-edition-url.txt");

  const tagAndAppend = (entry: PostEntry): void => {
    if (isTest) entry.is_test = true;
    appendSocialPosts(publishedPath, [entry]);
  };

  for (const d of destaques) {
    // Releitura a cada iteração para detectar entradas concorrentes
    const published = loadPublished(publishedPath);

    if (skipExisting) {
      const existing = published.posts.find(
        (p) =>
          p.platform === "threads" &&
          p.destaque === d &&
          (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
      );
      if (existing) {
        console.log(`SKIP threads/${d} — already ${existing.status}`);
        results.push(existing);
        skippedCount += 1;
        continue;
      }
    }

    // Extrair texto do post — SÓ a seção '# Curto' (#4294, mesmo contrato de
    // prep-twitter-posts.ts #3994): nunca cai pra outra seção. `!text` cobre
    // tanto ausência (null) quanto conteúdo vazio após strip de comentários
    // HTML (ex: destaque com só `<!-- comentario -->`) — ambos "incompleto".
    // Diferente do comportamento antigo (fail-fast com status "failed"),
    // isso é um skip: nada foi tentado, então nada é persistido em
    // 06-social-published.json — o destaque simplesmente não sai neste run.
    // #4309 finding 2 (self-review #2038): extractPostText pode lançar via
    // assertNoScaffolding (guard de scaffolding vazado/placeholder não
    // resolvido) — try/catch por destaque evita que 1 destaque ruim derrube
    // o main() inteiro; grava "failed" e segue com os demais destaques,
    // mesmo padrão de status:"failed" já usado no resto deste arquivo.
    let text: string | null;
    try {
      text = extractPostText(socialMd, d);
    } catch (e: any) {
      console.error(`ERROR extracting text for threads/${d}: ${e.message}`);
      const entry: PostEntry = {
        platform: "threads",
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
    if (!text) {
      const reason = "destaque ausente ou incompleto na seção '# Curto' — sem fallback (#4294)";
      console.warn(`SKIP threads/${d}: ${reason}`);
      skippedNoCurto.push({ destaque: d, reason });
      skippedCount += 1;
      continue;
    }

    // Guard não-fatal (#4294, mesmo padrão do #3277): se o texto não contiver
    // a URL da edição resolvida, avisa em stderr + data/run-log.jsonl mas
    // NUNCA bloqueia o dispatch — o post sai mesmo assim. A checagem usa o
    // texto AINDA SEM tag (#4295) — a tag muda a URL literal, então rodar a
    // checagem depois dela sempre acusaria falso-positivo.
    if (existsSync(editionUrlFile)) {
      const editionUrl = readFileSync(editionUrlFile, "utf8").trim();
      if (editionUrl) {
        if (!textContainsEditionUrl(text, editionUrl)) {
          const editionId = /^\d{6}$/.test(editionDate) ? editionDate : null;
          warnMissingEditionUrl(d, text, editionUrl, editionId, logRootDir);
        }
        // #4295: tag UTM per-channel (utm_source=threads) na URL já resolvida.
        text = tagEditionUrlInText(text, editionUrl, THREADS_EDITION_UTM);
      }
    }

    // Dividir em chunks de 500 chars se necessário
    const chunks = splitIntoThreadChunks(text, THREADS_CHAR_LIMIT);
    if (chunks.length > 1) {
      console.log(`threads/${d}: texto longo (${text.length} chars) → ${chunks.length} posts encadeados`);
    }

    // --dry-run guard: do NOT call fetch. Print what would be published and skip.
    // This is a real guard (unlike --test-mode which only skips sleep).
    if (isDryRun) {
      console.log(
        `DRY-RUN threads/${d}: ${chunks.length} chunk(s), ${text.length} chars total\n` +
        chunks.map((c, i) => `  chunk ${i + 1}: ${c.slice(0, 80)}${c.length > 80 ? "…" : ""}`).join("\n"),
      );
      const entry: PostEntry = {
        platform: "threads",
        destaque: d,
        url: null,
        status: "draft",
        scheduled_at: null,
        reason: "dry-run — não publicado",
      };
      results.push(entry);
      continue;
    }

    // #3944 Parte B — modo --schedule: enfileira no Worker em vez de publicar
    // agora. Só suporta post de 1 chunk (≤500 chars) — chunking agendado
    // (thread multi-post via reply_to_id) não é implementado no Worker: um
    // retry automático de falha no meio do encadeamento duplicaria posts já
    // publicados. Textos maiores falham aqui com motivo claro (publique
    // manualmente sem --schedule ou encurte o texto) em vez de publicar só o
    // primeiro chunk silenciosamente. scheduled_at vem da MESMA fonte usada
    // por LinkedIn/Facebook/Instagram (fallback_schedule — compute-social-schedule.ts).
    if (doSchedule) {
      if (chunks.length > 1) {
        console.error(
          `SKIP threads/${d}: texto de ${text.length} chars excede o limite de 1 chunk (500) suportado ` +
          `por --schedule (#3944 Parte B). Publique manualmente sem --schedule ou encurte o texto.`,
        );
        const entry: PostEntry = {
          platform: "threads",
          destaque: d,
          url: null,
          status: "failed",
          scheduled_at: null,
          reason: `texto de ${text.length} chars excede 500 — chunking agendado não suportado`,
        };
        tagAndAppend(entry);
        results.push(entry);
        continue;
      }

      let scheduledIso: string;
      try {
        scheduledIso = computeScheduledAt({
          config: platformConfig,
          editionDate,
          destaque: d as "d1" | "d2" | "d3",
          platform: "threads",
        });
      } catch (e: any) {
        console.error(`SKIP threads/${d}: schedule_error: ${e.message}`);
        const entry: PostEntry = {
          platform: "threads",
          destaque: d,
          url: null,
          status: "failed",
          scheduled_at: null,
          reason: `schedule_error: ${e.message}`,
        };
        tagAndAppend(entry);
        results.push(entry);
        continue;
      }

      // #6095 — carrossel diário (capa + 3 parágrafos + CTA) quando os 5
      // slides existem em 06-public-images.json; senão cai pro comportamento
      // de sempre (image_url: null, post só-texto — Threads daily nunca
      // suportou imagem única, só o carrossel muda aqui). Tudo-ou-nada via
      // resolveCarouselImageUrls (mesmo helper que o Instagram já usa).
      const carouselImageUrls = resolveCarouselImageUrls(publicImages.images, d);

      try {
        const response = await postToWorkerQueue(workerUrl, workerToken, {
          text: chunks[0],
          image_url: null,
          ...(carouselImageUrls && { image_urls: carouselImageUrls }),
          scheduled_at: scheduledIso,
          destaque: d,
          channel: "threads",
        });
        const entry: PostEntry = {
          platform: "threads",
          destaque: d,
          url: null,
          status: "scheduled",
          scheduled_at: scheduledIso,
          worker_queue_key: response.key,
        };
        tagAndAppend(entry);
        results.push(entry);
        console.log(`OK threads/${d} — scheduled at ${scheduledIso} (worker_queue_key=${response.key})`);
      } catch (e: any) {
        console.error(`FAILED threads/${d}: ${e.message}`);
        const entry: PostEntry = {
          platform: "threads",
          destaque: d,
          url: null,
          status: "failed",
          scheduled_at: null,
          reason: e.message,
        };
        tagAndAppend(entry);
        results.push(entry);
      }
      continue;
    }

    // Publicar com retry + exponential backoff (análogo a publish-instagram.ts).
    //
    // ATOMICIDADE: retry só é seguro para posts de chunk único (1 container →
    // threads_publish). Quando há múltiplos chunks, publishThread publica o
    // chunk 1 antes de tentar o chunk 2. Se o chunk 2 falha, o chunk 1 já está
    // ao vivo no Threads — um retry recomeça do zero e cria um segundo post
    // raiz independente (post órfão). Para evitar isso, não fazemos retry em
    // falhas de multi-chunk: a primeira exceção é registrada como "failed" e
    // o editor resolve manualmente.
    const isMultiChunk = chunks.length > 1;
    let lastError = "";
    let success = false;

    const maxAttempts = isMultiChunk ? 1 : 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`Publishing threads/${d} (attempt ${attempt}/${maxAttempts}, ${chunks.length} chunk(s))...`);

        const rootMediaId = await publishThread(threadsUserId, accessToken, chunks, apiVersion);
        console.log(`  Publicado: ${rootMediaId}`);

        // Buscar permalink real (best-effort)
        const postUrl = await fetchThreadsPermalink(rootMediaId, accessToken, apiVersion);
        const entry: PostEntry = {
          platform: "threads",
          destaque: d,
          url: postUrl,
          status: "published",
          scheduled_at: null,
          threads_media_id: rootMediaId,
          threads_chunks: chunks.length,
        };

        tagAndAppend(entry);
        results.push(entry);
        console.log(`OK threads/${d} — published — ${postUrl ?? `(media_id ${rootMediaId})`}`);
        success = true;
        break;
      } catch (e: any) {
        lastError = e.message;
        console.error(`Attempt ${attempt}/${maxAttempts} failed for threads/${d}: ${lastError}`);
        if (isMultiChunk) {
          console.warn(
            `threads/${d}: post multi-chunk — sem retry para evitar posts órfãos. ` +
            `Chunk 1 pode ter sido publicado. Verificar manualmente no Threads.`,
          );
        } else if (attempt < maxAttempts) {
          const delaySec = Math.pow(2, attempt - 1); // 1s, 2s
          if (!isTest) {
            await new Promise((r) => setTimeout(r, delaySec * 1000));
          }
        }
      }
    }

    if (!success) {
      const entry: PostEntry = {
        platform: "threads",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: lastError,
      };
      tagAndAppend(entry);
      results.push(entry);
    }
  }

  const summary = {
    total: results.length,
    published: results.filter((r) => r.status === "published").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: skippedCount,
  };

  console.log(
    JSON.stringify(
      { out_path: publishedPath, summary, posts: results, skipped_no_curto: skippedNoCurto },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
