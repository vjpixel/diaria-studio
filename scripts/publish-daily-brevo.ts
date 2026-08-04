#!/usr/bin/env node
/**
 * scripts/publish-daily-brevo.ts (#4266, item 6 do plano da issue)
 *
 * Publisher FINO sobre `brevo-client.ts` pro canal Brevo próprio do editor
 * (`platform.config.json` → `brevo_diaria`) — distinto de
 * `scripts/publish-monthly.ts` (`@deprecated` #2009, fluxo mensal da parceria
 * Clarice). Não generaliza aquele script — reusa só a camada de transporte
 * (`brevoPost`/`brevoGetList`), não sua lógica de campanha mensal.
 *
 * Pipeline (tudo já existente, remontado aqui — nenhum novo parser/renderer):
 *   1. `extractContent(editionDir)` (`newsletter-parse.ts`) — mesmo parse do
 *      Stage 4 diário, em seguida `stripGreetingAndSupporterBlocks` (achado
 *      260803) remove a saudação pessoal e o agradecimento a apoiadores —
 *      ambos presumem relação já estabelecida com quem lê, incompatível com
 *      o público Pending (nunca confirmou o cadastro); o bloco de intro do
 *      item 4 abaixo já cobre a explicação necessária.
 *   2. `renderHTML(content, { esp: "brevo", fullDocument: true })` — variante
 *      Brevo já wired desde #4266 item 1; desde #4517 a merge tag do link de
 *      voto do É IA? é o token opaco `{{ contact.POLL_TOKEN }}` (era
 *      `{{ contact.EMAIL }}` cru — mesmo vazamento que o #4487 fechou pro
 *      Beehiiv, reaberto aqui até o #4517).
 *   3. Substituição de imagem via `06-public-images.json` (raiz da edição,
 *      não `_internal/` — mesma convenção de `publish-linkedin.ts`/
 *      `publish-instagram.ts`/`render-social-html.ts`) — MESMO mapa que o
 *      publisher Beehiiv usa (URLs públicas são ESP-agnósticas, não precisa
 *      reupload).
 *   4. Injeção do bloco de intro OBRIGATÓRIO do segmento Pending
 *      (`brevo-diaria-intro.ts`, #4266 item 5) — recusa publicar sem ele.
 *   5. Cap de envio diário (`brevo_diaria.daily_send_cap`, default 300) —
 *      GUARD de segurança, não rotação de ondas: se a lista Brevo tiver mais
 *      assinantes que o cap, o script ABORTA em vez de enviar uma fatia
 *      arbitrária ou estourar o cap. Construir rotação por ondas (como
 *      `clarice-build-waves-store.ts` faz pra Clarice) é trabalho futuro,
 *      fora do escopo desta unidade — ver PR body.
 *   6. Injeção do token opaco de voto (`inject-poll-token-brevo.ts`, #4517)
 *      pra TODA a lista Brevo — roda INLINE (a lista é capada em
 *      `daily_send_cap`, barato o bastante por envio), diferente da Beehiiv
 *      (base inteira, task agendada separada). ABORTA se algum contato
 *      falhar (nunca envia com merge tag sem token resolvido — fail-closed).
 *      #4532: além de `failed > 0`, reconcilia `total_contacts` enumerados
 *      contra `listInfo.totalSubscribers` (`checkContactCountReconciliation`)
 *      — enumerar MENOS contatos que a lista realmente tem (silenciosamente,
 *      sem nenhum `failed`) também aborta.
 *   7. Cria a campanha Brevo (`POST /emailCampaigns`) — sem `--send-now`/
 *      `--schedule-at`, fica como rascunho na conta Brevo (mesma cautela do
 *      publisher mensal: nunca dispara sozinho).
 *
 * Exit codes: 1 uso/erro fatal genérico; 2 guard de `--i-reviewed-the-copy`
 * ou `brevo_diaria`/config ausente; 3 cap diário excedido; 4 credenciais do
 * token de voto ausentes; 5 falha ao injetar o token em ≥1 contato; 6
 * divergência entre a enumeração e `listInfo.totalSubscribers` (#4532); 7
 * assunto vazio/em branco (`content.title` ausente, #4588).
 *
 * Uso:
 *   npx tsx scripts/publish-daily-brevo.ts <edition-dir> --dry-run
 *   npx tsx scripts/publish-daily-brevo.ts <edition-dir> --i-reviewed-the-copy
 *
 * `--i-reviewed-the-copy`: obrigatória pra qualquer ação fora de `--dry-run`
 * — confirmação explícita de que o editor revisou a cópia RASCUNHO do bloco
 * de intro (`context/snippets/brevo-diaria-pending-intro.md`, ver disclaimer
 * no próprio arquivo). Sem ela, o script recusa criar a campanha (mesmo em
 * modo "só draft") — a issue #4266 tratou esse bloco como decisão de
 * compliance, não um detalhe de copy qualquer.
 *
 * Sem `--send-now`/`--schedule-at` (#4398 review: removida a menção no uso
 * acima — o script nunca implementou essa flag; a campanha sempre sai como
 * rascunho, schedule/send é ação manual separada, mesma cautela do publisher
 * mensal).
 *
 * #4517: fora de `--dry-run`, requer também `POLL_SECRET` +
 * `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN` no ambiente (mesmas
 * credenciais que `inject-poll-token.ts`, Beehiiv, já usa) — sem elas o
 * script aborta ANTES de criar a campanha, nunca cai de volta pro
 * `{{ contact.EMAIL }}` cru.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { extractContent, type NewsletterContent } from "./lib/newsletter-parse.ts";
import { renderHTML } from "./lib/newsletter-render-html.ts";
import { buildFilenameMap, substituteImagePlaceholders, type PublicImagesFile } from "./substitute-image-urls.ts";
import { renderPendingIntroHtml, injectPendingIntro } from "./lib/brevo-diaria-intro.ts";
import { brevoPost, brevoGetList } from "./lib/brevo-client.ts";
import { run as injectPollTokenBrevo, DEFAULT_POLL_KV_NAMESPACE_ID } from "./inject-poll-token-brevo.ts"; // #4517

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface BrevoDiariaConfig {
  api_key_env: string;
  list_id: number | null;
  sender_email: string | null;
  sender_name: string;
  daily_send_cap: number;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
}

/** `06-public-images.json` vive na RAIZ da edição (produzido por
 * `upload-images-public.ts`), nunca em `_internal/` — mesma convenção de
 * `publish-linkedin.ts`/`publish-instagram.ts`/`render-social-html.ts`. */
export function resolvePublicImagesPath(editionDir: string): string {
  return resolve(editionDir, "06-public-images.json");
}

/**
 * Pura — remove a saudação pessoal ("Olá! Eu sou o Pixel...", capturada em
 * `content.coverageLine`/`coverageLineTrailer`) e o agradecimento a
 * apoiadores (`content.introCallout`) do conteúdo antes do render pro
 * segmento Pending Brevo (achado 260803, revisão do editor sobre o 1º
 * rascunho real). Os dois presumem uma relação já estabelecida com quem lê
 * ("nosso apoiador", tom de continuidade de quem já é assinante confirmado)
 * que não se aplica a este público — ele nunca confirmou o cadastro. O bloco
 * de intro do #4266 (`renderPendingIntroHtml`) já cobre "por que você está
 * recebendo isso"; manter a saudação normal em cima dele duplicava a
 * explicação com tom incompatível.
 */
export function stripGreetingAndSupporterBlocks(content: NewsletterContent): NewsletterContent {
  return { ...content, coverageLine: null, coverageLineTrailer: null, introCallout: null };
}

// ── subject/preview (puro) ──────────────────────────────────────────────

/**
 * Pura — assunto derivado do título do D1 (não há um "ASSUNTO" dedicado no
 * template diário, diferente do mensal — a diária usa metadados manuais na
 * UI do Beehiiv, CLAUDE.md §Publicadores). Sem prefixo de marca (decisão do
 * editor, 260804) — o remetente (`sender_name: "diar.ia.br"`) já identifica
 * a marca no inbox, repetir no assunto é redundante. Formato anterior
 * ("diar.ia.br — {título}") usado só na campanha #13/edição 260804.
 */
export function buildDailyBrevoSubject(content: Pick<NewsletterContent, "title">): string {
  return content.title;
}

/** Pura — preview text a partir do subtítulo (mesmo campo usado como "por
 * que isso importa" resumido nas outras plataformas de publicação). */
export function buildDailyBrevoPreviewText(content: Pick<NewsletterContent, "subtitle">): string {
  return content.subtitle;
}

export type SubjectPresenceCheck = { ok: true } | { ok: false; reason: string };

/**
 * Pura — guard contra assunto vazio/em branco (#4588, achado do
 * silent-failure-hunter no fleet review da PR #4586). `buildDailyBrevoSubject`
 * virou um passthrough puro de `content.title` (era `` `diar.ia.br — ${title}` ``
 * — mesmo com título vazio, o prefixo garantia um assunto não-vazio, um sinal
 * fraco mas visível; decisão do editor 260804 removeu o prefixo). Sem este
 * guard, um `content.title` vazio por defeito upstream (parse malformado de
 * `02-reviewed.md`, edição manual via Studio que apaga o título sem quebrar
 * o parser de contagem de destaques) chegava até `POST /emailCampaigns` sem
 * nenhum sinal — a campanha sempre sai como RASCUNHO (nunca agenda/envia
 * sozinha), então o blast radius é baixo, mas hoje só um humano abrindo o
 * rascunho na Brevo notaria.
 */
export function checkSubjectNotEmpty(subject: string): SubjectPresenceCheck {
  if (subject.trim() === "") {
    return { ok: false, reason: "assunto vazio (content.title em branco)" };
  }
  return { ok: true };
}

// ── cap de envio (puro) ──────────────────────────────────────────────────

export type DailyCapCheck = { ok: true } | { ok: false; reason: string };

/**
 * Pura — guard de segurança, NÃO rotação de ondas (ver disclaimer no
 * cabeçalho do módulo). `totalSubscribers` vem de `brevoGetList` (contagem
 * ao vivo da lista Brevo) — se exceder o cap, o script recusa criar a
 * campanha em vez de enviar uma fatia arbitrária.
 */
export function checkDailySendCap(totalSubscribers: number, cap: number): DailyCapCheck {
  if (totalSubscribers <= cap) return { ok: true };
  return {
    ok: false,
    reason:
      `lista Brevo tem ${totalSubscribers} assinante(s), acima do cap diário (${cap}). ` +
      "Este publisher não faz rotação por ondas (fora do escopo desta unidade) — " +
      "reduza a lista ou implemente segmentação antes de enviar.",
  };
}

// ── guards de pré-condição fora de --dry-run (puro) ───────────────────────

export type PreflightGuardCheck = { ok: true } | { ok: false; reason: string };

/**
 * Pura — os 3 guards de pré-condição pra rodar fora de `--dry-run` (#4404:
 * antes só `list_id` e a API key eram validados; `sender_email` null — o
 * default de `platform.config.json` até o editor criar a conta Brevo própria
 * — caía direto num erro genérico da API Brevo em vez do erro
 * explícito/didático que os outros 2 campos já tinham). Extraída de `main()`
 * pra ser testável sem mockar env/`platform.config.json` inteiros (mesmo
 * padrão de `evaluate-brevo-diaria.ts`, #4398 review). Mensagens idênticas às
 * que já existiam inline.
 */
export function checkBrevoDiariaGuards(params: {
  dryRun: boolean;
  brevoDiaria: BrevoDiariaConfig | undefined;
  apiKey: string | undefined;
}): PreflightGuardCheck {
  const { dryRun, brevoDiaria, apiKey } = params;
  if (!brevoDiaria) {
    return { ok: false, reason: "brevo_diaria não configurado em platform.config.json." };
  }
  if (!dryRun && brevoDiaria.list_id == null) {
    return { ok: false, reason: "brevo_diaria.list_id não definido em platform.config.json." };
  }
  if (!dryRun && !brevoDiaria.sender_email) {
    return { ok: false, reason: "brevo_diaria.sender_email não definido em platform.config.json." };
  }
  if (!dryRun && !apiKey) {
    return { ok: false, reason: `${brevoDiaria.api_key_env} não definido no ambiente.` };
  }
  return { ok: true };
}

/**
 * Pura (#4517) — guard de pré-condição pra rodar fora de `--dry-run`: as 3
 * credenciais que `inject-poll-token-brevo.ts` exige pra popular o token
 * opaco de voto ANTES de criar a campanha (mesma disciplina de
 * `checkBrevoDiariaGuards` acima — erro explícito/didático em vez de deixar
 * a falha estourar como exceção genérica no meio do fluxo). Chamada só
 * quando `dryRun === false` no caller — o modo dry-run nunca cria campanha,
 * então nunca precisa dessas credenciais.
 */
export function checkPollTokenGuards(params: {
  pollSecret: string | undefined;
  cloudflareAccountId: string | undefined;
  cloudflareWorkersToken: string | undefined;
}): PreflightGuardCheck {
  const { pollSecret, cloudflareAccountId, cloudflareWorkersToken } = params;
  if (!pollSecret) {
    return {
      ok: false,
      reason:
        "POLL_SECRET não definido no ambiente — obrigatório pra popular o token opaco de voto " +
        "(paridade #4487/#4517) antes de criar a campanha Brevo. Nunca envia com {{ contact.EMAIL }} cru.",
    };
  }
  if (!cloudflareAccountId) {
    return { ok: false, reason: "CLOUDFLARE_ACCOUNT_ID não definido no ambiente (#4517, injeção do token de voto)." };
  }
  if (!cloudflareWorkersToken) {
    return { ok: false, reason: "CLOUDFLARE_WORKERS_TOKEN não definido no ambiente (#4517, injeção do token de voto)." };
  }
  return { ok: true };
}

/**
 * Pura (#4532, achado HIGH do silent-failure-hunter — fleet review pré-merge
 * do #4532) — reconcilia `injectionResult.total_contacts` (enumeração
 * paginada de `iterateListContacts`, `inject-poll-token-brevo.ts`) contra
 * `listInfo.totalSubscribers` (`brevoGetList`, endpoint SEPARADO, já
 * consultado por `checkDailySendCap`). Defesa em profundidade: mesmo com o
 * fix em `iterateListContacts` (que agora falha alto em vez de tratar
 * status != 200 como lista vazia), esta checagem garante que qualquer outra
 * forma de enumeração incompleta (resposta 200 com corpo truncado/malformado,
 * regressão futura na paginação) nunca passe silenciosamente pelo gate de
 * `injectionResult.failed > 0` — enumerar MENOS contatos do que a lista
 * realmente tem significa que parte da audiência real do envio nunca
 * recebeu `POLL_TOKEN`, e o script criaria a campanha achando que protegeu
 * todo mundo.
 */
export function checkContactCountReconciliation(
  totalContacts: number,
  listTotalSubscribers: number,
): PreflightGuardCheck {
  if (totalContacts >= listTotalSubscribers) return { ok: true };
  const detail =
    totalContacts === 0
      ? "a enumeração retornou 0 contato(s)"
      : `a enumeração retornou apenas ${totalContacts} contato(s)`;
  return {
    ok: false,
    reason:
      `${detail}, mas a lista Brevo reporta ${listTotalSubscribers} assinante(s) (GET /contacts/lists/{id}, ` +
      "brevoGetList) — divergência entre a contagem da lista e a enumeração paginada usada pra injetar o token " +
      "opaco de voto; abortando (nunca envia com parte da audiência sem POLL_TOKEN confirmado, #4532).",
  };
}

// ── montagem do HTML final (puro, dado o conteúdo já parseado) ──────────

/**
 * Pura — monta o HTML final: render Brevo (esp+fullDocument) → substitui
 * placeholders de imagem → injeta o bloco de intro obrigatório. Lança se o
 * bloco de intro não existir (`introHtml === null`) — nunca envia pro
 * segmento Pending sem a explicação (#4266 item 5, decisão de compliance).
 */
export function buildDailyBrevoHtml(
  content: NewsletterContent,
  publicImages: PublicImagesFile,
  introHtml: string | null,
): { html: string; unresolvedImages: string[] } {
  if (!introHtml) {
    throw new Error(
      "bloco de intro do segmento Pending ausente/vazio (context/snippets/brevo-diaria-pending-intro.md) — " +
        "publish-daily-brevo.ts recusa montar o HTML sem ele (decisão de compliance, #4266 item 5).",
    );
  }
  const rendered = renderHTML(content, { esp: "brevo", fullDocument: true });
  const filenameMap = buildFilenameMap(publicImages.images ?? {});
  const { html: substituted, unresolved } = substituteImagePlaceholders(rendered, filenameMap);
  const final = injectPendingIntro(substituted, introHtml);
  return { html: final, unresolvedImages: unresolved };
}

// ── main ─────────────────────────────────────────────────────────────────

/**
 * @param rootDirOverride Opcional. Default = raiz do repo. Em testes, passar
 *   tempdir com fixture controlado (`platform.config.json`, `data/editions/`)
 *   pra evitar tocar `data/` real — mesmo padrão de
 *   `select-linkedin-weekly.ts main(rootDirOverride)` (#4489) usado pelo
 *   teste de integração deste script (#4532, achado CRITICAL do
 *   pr-test-analyzer: antes `main()` não era exportado e o wiring
 *   fail-closed completo — guard → injeção → abort ANTES de criar a
 *   campanha — nunca era exercitado de ponta a ponta por nenhum teste).
 */
export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const editionDirArg = argv.find((a) => !a.startsWith("--"));
  const dryRun = hasFlag(argv, "dry-run");
  const reviewedCopy = hasFlag(argv, "i-reviewed-the-copy");
  const log = (msg: string) => process.stderr.write(`[publish-daily-brevo] ${msg}\n`);

  if (!editionDirArg) {
    log("uso: npx tsx scripts/publish-daily-brevo.ts <edition-dir> [--dry-run] [--i-reviewed-the-copy]");
    process.exit(1);
  }
  if (!dryRun && !reviewedCopy) {
    log(
      "ERRO: fora de --dry-run, é obrigatório passar --i-reviewed-the-copy — confirmação explícita de " +
        "que o editor revisou context/snippets/brevo-diaria-pending-intro.md (ainda RASCUNHO). " +
        "Ver disclaimer no próprio arquivo.",
    );
    process.exit(2);
  }

  const platformConfig = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as PlatformConfig;
  const brevoDiaria = platformConfig.brevo_diaria;
  const apiKey = brevoDiaria ? process.env[brevoDiaria.api_key_env] : undefined;
  const guardCheck = checkBrevoDiariaGuards({ dryRun, brevoDiaria, apiKey });
  if (!guardCheck.ok) {
    log(`ERRO: ${guardCheck.reason}`);
    process.exit(2);
  }

  const editionDir = resolve(rootDir, editionDirArg);
  const content = stripGreetingAndSupporterBlocks(extractContent(editionDir));

  const imagesPath = resolvePublicImagesPath(editionDir);
  const publicImages: PublicImagesFile = existsSync(imagesPath)
    ? (JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesFile)
    : {};

  const introHtml = renderPendingIntroHtml();
  const { html, unresolvedImages } = buildDailyBrevoHtml(content, publicImages, introHtml);
  if (unresolvedImages.length > 0) {
    log(`warn: ${unresolvedImages.length} placeholder(s) de imagem sem URL: ${unresolvedImages.join(", ")}`);
  }

  const subject = buildDailyBrevoSubject(content);
  const previewText = buildDailyBrevoPreviewText(content);

  // #4588: checado ANTES do branch `--dry-run` de propósito — o editor deve
  // ver o erro já no dry-run, não só quando for de fato criar a campanha.
  const subjectCheck = checkSubjectNotEmpty(subject);
  if (!subjectCheck.ok) {
    log(`ERRO: ${subjectCheck.reason} — abortando antes de criar a campanha. Verifique ${editionDir}/02-reviewed.md.`);
    process.exit(7);
  }

  if (dryRun) {
    const internalDir = resolve(editionDir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    const outPath = resolve(internalDir, "newsletter-final-brevo.html");
    writeFileSync(outPath, html);
    log(`[DRY RUN] HTML escrito em ${outPath}`);
    log(`  Assunto: ${subject}`);
    log(`  Preview: ${previewText}`);
    return;
  }

  const listInfo = await brevoGetList(apiKey!, brevoDiaria!.list_id as number);
  const cap = brevoDiaria!.daily_send_cap ?? 300;
  const capCheck = checkDailySendCap(listInfo.totalSubscribers, cap);
  if (!capCheck.ok) {
    log(`ERRO: ${(capCheck as { ok: false; reason: string }).reason}`);
    process.exit(3);
  }

  // #4517: popula o token opaco de voto (`POLL_TOKEN`) pra TODA a lista Brevo
  // ANTES de criar a campanha — paridade com a proteção Beehiiv do #4487.
  // Roda INLINE (não uma task agendada, diferente da Beehiiv) porque a lista
  // aqui é capada em `daily_send_cap` — barato o bastante por envio, e
  // garante que NUNCA falta rodar essa etapa antes de um disparo real.
  const pollTokenGuard = checkPollTokenGuards({
    pollSecret: process.env.POLL_SECRET,
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareWorkersToken: process.env.CLOUDFLARE_WORKERS_TOKEN,
  });
  if (!pollTokenGuard.ok) {
    log(`ERRO: ${(pollTokenGuard as { ok: false; reason: string }).reason}`);
    process.exit(4);
  }
  const injectionResult = await injectPollTokenBrevo({
    dryRun: false,
    force: false,
    apiOpts: { apiKey: apiKey!, listId: brevoDiaria!.list_id as number },
    secret: process.env.POLL_SECRET!,
    kvConfig: {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_WORKERS_TOKEN,
      kvNamespaceId: process.env.POLL_KV_NAMESPACE_ID ?? DEFAULT_POLL_KV_NAMESPACE_ID,
    },
  });
  if (injectionResult.failed > 0) {
    // #4532 (achado type-design): cita os e-mails que falharam (até 10) em
    // vez de só a contagem — sem isso o operador tinha que garimpar stderr
    // manualmente pra saber QUAIS contatos ficaram sem POLL_TOKEN.
    const preview = injectionResult.failedContacts
      .slice(0, 10)
      .map((f) => `${f.email} (${f.error.slice(0, 80)})`)
      .join("; ");
    const more = injectionResult.failedContacts.length > 10
      ? ` … e mais ${injectionResult.failedContacts.length - 10}.`
      : "";
    log(
      `ERRO: ${injectionResult.failed} contato(s) da lista Brevo falharam ao receber o token opaco de voto (#4517) — ` +
        `abortando envio (nunca envia com merge tag sem token resolvido, fail-closed). Falhas: ${preview}${more}`,
    );
    process.exit(5);
  }

  // #4532 (achado HIGH): reconcilia a enumeração de `injectPollTokenBrevo`
  // contra a contagem ao vivo da lista (`listInfo`, já obtida acima pro cap
  // check) — nunca deixa uma enumeração incompleta passar como sucesso só
  // porque `failed === 0` (0 falhas sobre 0 contatos enumerados também é
  // "0 falhas").
  const reconciliation = checkContactCountReconciliation(injectionResult.total_contacts, listInfo.totalSubscribers);
  if (!reconciliation.ok) {
    log(`ERRO: ${(reconciliation as { ok: false; reason: string }).reason}`);
    process.exit(6);
  }

  log(
    `tokens de voto (#4517): ${injectionResult.patched} patcheado(s), ` +
      `${injectionResult.skipped_already_correct} já corretos, ${injectionResult.total_contacts} contato(s) na lista.`,
  );

  const campaignResp = (await brevoPost(apiKey!, "/emailCampaigns", {
    name: `diar.ia.br diária — ${new Date().toISOString().slice(0, 16)}`,
    subject,
    previewText,
    sender: { name: brevoDiaria!.sender_name, email: brevoDiaria!.sender_email },
    recipients: { listIds: [brevoDiaria!.list_id] },
    htmlContent: html,
  })) as Record<string, unknown>;

  if (typeof campaignResp.id !== "number") {
    throw new Error(`Brevo API retornou resposta inesperada (sem campo 'id'): ${JSON.stringify(campaignResp)}`);
  }
  log(`campanha criada: id=${campaignResp.id} (rascunho — schedule/send é ação manual separada, mesma cautela do publisher mensal)`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[publish-daily-brevo] erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
