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
 *   6b. Cota da CONTA Brevo (#6146 — balde único de 300/dia, transacional +
 *      marketing, `scripts/lib/brevo-account-quota.ts`). Só AVISA aqui; ver
 *      a nota de exit codes abaixo.
 *   7. Cria a campanha Brevo (`POST /emailCampaigns`) — sem `--send-now`/
 *      `--schedule-at`, fica como rascunho na conta Brevo (mesma cautela do
 *      publisher mensal: nunca dispara sozinho).
 *
 * Exit codes: 1 uso/erro fatal genérico (inclui guards de `--send-test`/
 * `--send-test-to` — sempre pré-`await`, ver #5086 abaixo); 2 guard de
 * `--i-reviewed-the-copy` ou `brevo_diaria`/config ausente; 3 cap diário
 * excedido; 4 credenciais do token de voto ausentes; 5 falha ao injetar o
 * token em ≥1 contato; 6 divergência entre a enumeração e
 * `listInfo.totalSubscribers` (#4532); 7 assunto vazio/em branco
 * (`content.title` ausente, #4588). A cota da CONTA (#6146) NÃO tem exit
 * code aqui de propósito — vira aviso, porque rascunho não consome cota e o
 * dia do envio ainda não é conhecido; o gate duro é a Etapa 6.
 *
 * Uso:
 *   npx tsx scripts/publish-daily-brevo.ts <edition-dir> --dry-run
 *   npx tsx scripts/publish-daily-brevo.ts <edition-dir> --i-reviewed-the-copy
 *   npx tsx scripts/publish-daily-brevo.ts <edition-dir> --i-reviewed-the-copy \
 *     --send-test [--send-test-to <email>]
 *   npx tsx scripts/publish-daily-brevo.ts <edition-dir> --i-reviewed-the-copy --force
 *
 * `--i-reviewed-the-copy`: obrigatória pra qualquer ação fora de `--dry-run`
 * — confirmação explícita de que o editor revisou a cópia RASCUNHO do bloco
 * de intro (`data/snippets/brevo-diaria-pending-intro.md`, ver disclaimer
 * no próprio arquivo). Sem ela, o script recusa criar a campanha (mesmo em
 * modo "só draft") — a issue #4266 tratou esse bloco como decisão de
 * compliance, não um detalhe de copy qualquer.
 *
 * `--send-test` (#5086, espelha `publish-monthly.ts`): depois de criar o
 * rascunho (ou reaproveitar um já existente, ver #5677 abaixo), dispara
 * `POST /emailCampaigns/{id}/sendTest` pro destinatário resolvido
 * (`--send-test-to <email>`, senão `brevo_diaria.test_email` de
 * `platform.config.json`). Sem nenhum dos dois, o script recusa ANTES de
 * qualquer chamada de rede (`checkSendTestGuards`) — nunca manda `sendTest`
 * pra um destinatário indefinido. `--send-test-to` sem `--send-test` também é
 * rejeitado (mesma regra do publisher mensal).
 *
 * Idempotência de campanha (#5677): `<edition-dir>/_internal/brevo-diaria-published.json`
 * é escrito assim que a campanha é criada (status `"draft"`), ANTES de
 * qualquer `--send-test` — não só quando o teste dispara (mudança em relação
 * ao comportamento original do #5086). Uma invocação seguinte pra MESMA
 * edição (com ou sem `--send-test`) reaproveita o `campaign_id` já
 * registrado em vez de criar uma 2ª campanha (`decideCreateCampaignAction`)
 * — fecha o gap que causava 2 rascunhos duplicados na Brevo pro mesmo envio
 * (achado ao vivo na edição 260819, ids 24/25). `--force` cria uma campanha
 * nova mesmo com uma já registrada (mesmo escape hatch de
 * `publish-monthly-apoiadores-brevo.ts`). Quando `--send-test` de fato
 * dispara, o estado é atualizado pra status `"test_sent"` com `test_email` +
 * `test_sent_at`.
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
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, getStringArg, parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { extractContent, type NewsletterContent } from "./lib/newsletter-parse.ts";
import { renderHTMLWithWarnings, type RenderWarningEvent } from "./lib/newsletter-render-html.ts"; // #4687
import { buildFilenameMap, substituteImagePlaceholders, type PublicImagesFile } from "./substitute-image-urls.ts";
import { renderPendingIntroHtml, injectPendingIntro } from "./lib/brevo-diaria-intro.ts";
import { brevoPost, brevoPut, brevoGetList } from "./lib/brevo-client.ts";
import { run as injectPollTokenBrevo, DEFAULT_POLL_KV_NAMESPACE_ID } from "./inject-poll-token-brevo.ts"; // #4517
import { EDITOR_SEED_EMAILS } from "./lib/editor-copy.ts"; // #4631
import { applyKitActiveExclusionGuard } from "./lib/brevo-kit-active-exclusion.ts"; // #6485
import { resolveKitConfig } from "./lib/kit-config.ts"; // #6485
import { logEvent } from "./lib/run-log.ts"; // #6501
import {
  checkAccountSendQuota,
  resolveAccountDailyLimit,
  describeQuotaWarnings,
  fetchAccountQuotaSnapshot,
  toStatsDay,
  type BrevoAccountLimitConfig,
} from "./lib/brevo-account-quota.ts"; // #6146

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface BrevoDiariaConfig extends BrevoAccountLimitConfig {
  api_key_env: string;
  list_id: number | null;
  sender_email: string | null;
  sender_name: string;
  daily_send_cap: number;
  /** #5086 — destinatário default de `--send-test` quando `--send-test-to`
   * não é passado. Ausente/null é válido (config antiga, ou editor ainda não
   * configurou) — nesse caso `--send-test` sem `--send-test-to` é rejeitado
   * por `checkSendTestGuards`, nunca cai num `emailTo: [undefined]`. */
  test_email?: string | null;
}
interface PlatformConfig {
  brevo_diaria?: BrevoDiariaConfig;
}

/** #5086/#5677 — mirror mínimo de `MonthlyPublished` (`publish-monthly.ts`).
 * Não tenta ser um registro completo de publicação como o mensal (sem
 * `--send-now`/`--schedule-at` aqui ainda, #4980).
 *
 * `status: "draft"` (#5677): escrito assim que a campanha é criada, ANTES de
 * qualquer `--send-test` — fecha o gap que causava campanha duplicada
 * (rodar sem `--send-test` não deixava rastro nenhum; uma 2ª invocação com
 * `--send-test` não tinha como saber que já existia um rascunho e criava
 * uma 2ª campanha). `status: "test_sent"` (#5086) segue escrito só quando
 * `--send-test` de fato dispara, preservando `campaign_id`/`subject`/
 * `preview_text`/`list_id`/`created_at` do estado anterior (ver
 * `buildTestSentPublishedState`) — `test_email`/`test_sent_at` só existem
 * nesse status.
 *
 * `status: "scheduled"` (#5772): escrito por `scripts/schedule-daily-brevo.ts`
 * na Etapa 6, depois que o PUT de agendamento é confirmado via GET (nunca
 * a partir só do PUT) — mesma divisão 5/6 já usada pro Beehiiv (rascunho na
 * 5, agendamento na 6). `scheduled_at` só existe nesse status. */
export interface BrevoDiariaPublished {
  campaign_id: number;
  subject: string;
  preview_text: string;
  status: "draft" | "test_sent" | "scheduled";
  list_id: number;
  test_email?: string;
  test_sent_at?: string;
  /** #5772 — ISO 8601, só presente quando `status === "scheduled"`. */
  scheduled_at?: string;
  created_at: string;
}

/** Path do state file de publicação, sob `_internal/` da edição — mesma convenção de `05-published.json`/`06-social-published.json`. */
export function brevoDiariaPublishedPath(editionDir: string): string {
  return resolve(editionDir, "_internal", "brevo-diaria-published.json");
}

/**
 * Lê `_internal/brevo-diaria-published.json`. Tolerante (#5677, mesmo
 * padrão de `readApoiadoresState` em `monthly-apoiadores-state.ts`):
 * ausente/corrompido/shape inesperado → `null` ("nenhuma campanha criada
 * ainda pra esta edição"), nunca lança — um estado ilegível não deveria
 * travar o publisher, só reabrir a janela de criar uma campanha nova (o
 * pior caso é o mesmo de antes do #5677 existir).
 */
export function readBrevoDiariaPublished(editionDir: string): BrevoDiariaPublished | null {
  const path = brevoDiariaPublishedPath(editionDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BrevoDiariaPublished>;
    if (typeof parsed.campaign_id !== "number") return null;
    if (parsed.status !== "draft" && parsed.status !== "test_sent" && parsed.status !== "scheduled") return null;
    return {
      campaign_id: parsed.campaign_id,
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      preview_text: typeof parsed.preview_text === "string" ? parsed.preview_text : "",
      status: parsed.status,
      list_id: typeof parsed.list_id === "number" ? parsed.list_id : 0,
      test_email: typeof parsed.test_email === "string" ? parsed.test_email : undefined,
      test_sent_at: typeof parsed.test_sent_at === "string" ? parsed.test_sent_at : undefined,
      scheduled_at: typeof parsed.scheduled_at === "string" ? parsed.scheduled_at : undefined,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
    };
  } catch {
    return null;
  }
}

/** Escreve o state file (`_internal/` criado se faltar). */
export function writeBrevoDiariaPublished(editionDir: string, state: BrevoDiariaPublished): void {
  const internalDir = resolve(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(brevoDiariaPublishedPath(editionDir), JSON.stringify(state, null, 2) + "\n");
}

export type CreateCampaignDecision = { action: "create" } | { action: "reuse"; campaignId: number };

/**
 * Pura/testável (#5689) — compara o subject/previewText RECALCULADOS do
 * disco nesta invocação contra o que está registrado em
 * `brevo-diaria-published.json` da invocação anterior. Usado só pra decidir
 * se vale logar o aviso de divergência em `reuse` — a atualização em si
 * (`PUT /emailCampaigns/{id}`) roda incondicionalmente no branch `reuse`
 * (idempotente: recalcular e sobrescrever o mesmo conteúdo é barato e
 * elimina qualquer classe de drift, inclusive drift só no `html` — que não é
 * persistido no state file, então não dá pra comparar, mas o PUT
 * incondicional cobre esse caso de qualquer forma).
 */
export function campaignContentDiverges(params: {
  existingSubject: string;
  existingPreviewText: string;
  newSubject: string;
  newPreviewText: string;
}): boolean {
  return (
    params.existingSubject !== params.newSubject ||
    params.existingPreviewText !== params.newPreviewText
  );
}

/**
 * Pura/testável (#5677) — espelha `decidePublishBrevoAction` de
 * `monthly-apoiadores-state.ts`: decide se `main()` cria uma campanha Brevo
 * NOVA ou reaproveita a já registrada em `brevo-diaria-published.json` pra
 * esta edição. Sem `--force`, qualquer `campaign_id` já registrado (status
 * `draft` OU `test_sent` — ambos significam "a campanha já existe na
 * Brevo") é reaproveitado; `--force` sempre cria uma nova, de propósito
 * (mesmo escape hatch do publisher mensal).
 */
export function decideCreateCampaignAction(
  existing: BrevoDiariaPublished | null,
  force: boolean,
): CreateCampaignDecision {
  if (!force && existing && typeof existing.campaign_id === "number") {
    return { action: "reuse", campaignId: existing.campaign_id };
  }
  return { action: "create" };
}

/** Pura (#5677) — estado gravado assim que a campanha (nova) é criada, ANTES de qualquer `--send-test`. */
export function buildDraftPublishedState(params: {
  campaignId: number;
  subject: string;
  previewText: string;
  listId: number;
  createdAt: string;
}): BrevoDiariaPublished {
  return {
    campaign_id: params.campaignId,
    subject: params.subject,
    preview_text: params.previewText,
    status: "draft",
    list_id: params.listId,
    created_at: params.createdAt,
  };
}

/**
 * Pura (#5677/#5086) — estado gravado depois de um `--send-test` bem-
 * sucedido. Preserva `campaign_id`/`subject`/`preview_text`/`list_id`/
 * `created_at` do `base` (draft recém-criado OU reaproveitado de uma
 * invocação anterior) por spread — só `status`/`test_email`/`test_sent_at`
 * mudam. Mesma disciplina de `buildSentState` em `monthly-apoiadores-state.ts`.
 */
export function buildTestSentPublishedState(
  base: BrevoDiariaPublished,
  testEmail: string,
  testSentAt: string,
): BrevoDiariaPublished {
  return { ...base, status: "test_sent", test_email: testEmail, test_sent_at: testSentAt };
}

/**
 * Pura (#5772) — estado gravado pela Etapa 6 (`scripts/schedule-daily-brevo.ts`)
 * depois que o agendamento da campanha é confirmado via GET (nunca a partir
 * só do PUT). Preserva o resto de `base` por spread, mesma disciplina de
 * `buildTestSentPublishedState`.
 */
export function buildScheduledPublishedState(base: BrevoDiariaPublished, scheduledAt: string): BrevoDiariaPublished {
  return { ...base, status: "scheduled", scheduled_at: scheduledAt };
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
 *
 * #4631: `totalSubscribers` (bruto da API Brevo) inclui os `seedCount`
 * `EDITOR_SEED_EMAILS` — sondas de inbox placement permanentemente
 * vinculadas à lista, mas NUNCA rastreadas no store (`findOrphanContacts`,
 * `evaluate-brevo-diaria.ts`, documenta o mesmo fato do lado da avaliação).
 * Sem subtrair, o cap real disponível pra fila de reativação de verdade era
 * sempre `cap - seedCount`, não `cap` — achado ao vivo em 260804 (lista com
 * 179 assinantes brutos, cap 175; líquido dos 5 seeds = 174, abaixo do cap,
 * mas o guard antigo comparava o bruto (179) contra o cap (175) sem
 * subtrair e abortava mesmo assim; contornado naquela sessão só subindo o
 * cap pra 180 em `platform.config.json`, PR #4640 — este fix estrutural
 * substitui esse ajuste manual). `seedCount`
 * default é `EDITOR_SEED_EMAILS.length`; parametrizado pra teste sem
 * depender do tamanho real da constante.
 *
 * Piso contra `totalSubscribers < seedCount` (achado convergente
 * silent-failure-hunter + type-design-analyzer, fleet review da #4646): os
 * `seedCount` `EDITOR_SEED_EMAILS` ficam permanentemente vinculados à lista
 * — uma contagem bruta menor que `seedCount` é fisicamente impossível pra
 * uma lista saudável, e sinaliza API instável/resposta truncada, não uma
 * fila pequena legítima. Sem este guard, `netSubscribers` ficaria negativo
 * e passaria trivialmente (`<= cap`), mascarando a anomalia em vez de
 * denunciá-la — mesmo princípio de `detectZeroAudienceAnomaly`
 * (`clarice-reapply-scheduled-html.ts`, #4142): estado impossível é
 * hard-stop, nunca sucesso silencioso.
 */
/**
 * #6793 "Faixa B", item 5 (30/08/2026, decisão do editor): freio automático
 * de VOLUME (cap da LISTA) removido — este guard não recusa mais por
 * `netSubscribers > cap`. O piso contra estado IMPOSSÍVEL
 * (`totalSubscribers < seedCount`) continua intacto: não é freio de volume,
 * é detecção de dado corrompido/API instável (mesmo princípio aplicado ao
 * guard de blast radius PRÓPRIO de `sunset-dead-subscribers.ts` — critério
 * de correção nunca é removido junto com o freio deliberado).
 */
export function checkDailySendCap(
  totalSubscribers: number,
  cap: number,
  seedCount: number = EDITOR_SEED_EMAILS.length,
): DailyCapCheck {
  if (totalSubscribers < seedCount) {
    return {
      ok: false,
      reason:
        `lista Brevo reporta ${totalSubscribers} assinante(s) bruto(s), abaixo dos ${seedCount} ` +
        `EDITOR_SEED_EMAILS que ficam permanentemente vinculados à lista — contagem impossível pra uma ` +
        "lista saudável, sinal de erro/API instável (não de fila pequena). Abortando antes de comparar " +
        "contra o cap.",
    };
  }
  void cap; // #6793: parâmetro mantido pra compat de assinatura — não gate mais nada.
  return { ok: true };
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
 * Pura (#5086) — guards de `--send-test`/`--send-test-to`, checados ANTES de
 * qualquer `await` de rede (mesmo espírito de `checkSubjectNotEmpty`: o
 * editor deve ver o erro cedo, não só quando o script já criou metade do
 * estado). Espelha as 2 validações equivalentes de `publish-monthly.ts`
 * (`--send-test-to` requer `--send-test`; formato de e-mail básico), mais uma
 * 3ª que o mensal não precisa: ali `brevo.test_email` é sempre uma string
 * (contrato de `BrevoConfig`); aqui `test_email` é opcional
 * (`BrevoDiariaConfig`, campo novo) — sem ele e sem `--send-test-to`, o
 * script recusaria mandar `sendTest` pra um destinatário indefinido.
 */
export function checkSendTestGuards(params: {
  sendTest: boolean;
  sendTestTo: string | undefined;
  testEmail: string | null | undefined;
}): PreflightGuardCheck {
  const { sendTest, sendTestTo, testEmail } = params;
  if (sendTestTo !== undefined && !sendTest) {
    return { ok: false, reason: "--send-test-to requer --send-test." };
  }
  if (!sendTest) return { ok: true };
  if (sendTestTo !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sendTestTo)) {
    return { ok: false, reason: `--send-test-to inválido: "${sendTestTo}".` };
  }
  if (!sendTestTo && !testEmail) {
    return {
      ok: false,
      reason:
        "--send-test requer um destinatário — passe --send-test-to <email> ou configure " +
        "brevo_diaria.test_email em platform.config.json.",
    };
  }
  return { ok: true };
}

/**
 * Pura (#5086) — resolve o destinatário do teste (`--send-test-to` tem
 * prioridade sobre `brevo_diaria.test_email`). Assume que
 * `checkSendTestGuards` já confirmou `ok: true` pro mesmo par de argumentos —
 * lança se chamada com nenhum dos dois definidos (contrato violado pelo
 * caller, não um estado de usuário alcançável via CLI).
 */
export function resolveSendTestRecipient(
  sendTestTo: string | undefined,
  testEmail: string | null | undefined,
): string {
  const recipient = sendTestTo ?? testEmail;
  if (!recipient) {
    throw new Error(
      "resolveSendTestRecipient chamado sem destinatário resolvível — checkSendTestGuards deveria ter abortado antes.",
    );
  }
  return recipient;
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
 *
 * #4687 (fleet review do #4673): usa `renderHTMLWithWarnings` — antes este
 * render Brevo descartava qualquer `RenderWarningEvent` (ex: caixa de
 * divulgação dropada por falta de lacuna) em silêncio, porque nada aqui
 * chamava `getRenderWarnings()`. É o MESMO conteúdo comercial que o caminho
 * Beehiiv persiste em `_internal/render-warnings.json` — `main()` abaixo loga
 * os eventos (mesmo padrão de `unresolvedImages`); não há `_internal/` de
 * edição dedicado ao canal Brevo pra persistir um arquivo equivalente, então
 * o log continua sendo o sinal, como já era pra `unresolvedImages`.
 */
export function buildDailyBrevoHtml(
  content: NewsletterContent,
  publicImages: PublicImagesFile,
  introHtml: string | null,
): { html: string; unresolvedImages: string[]; renderWarnings: RenderWarningEvent[] } {
  if (!introHtml) {
    throw new Error(
      "bloco de intro do segmento Pending ausente/vazio (data/snippets/brevo-diaria-pending-intro.md) — " +
        "publish-daily-brevo.ts recusa montar o HTML sem ele (decisão de compliance, #4266 item 5).",
    );
  }
  const { html: rendered, warnings } = renderHTMLWithWarnings(content, { esp: "brevo", fullDocument: true });
  const filenameMap = buildFilenameMap(publicImages.images ?? {});
  const { html: substituted, unresolved } = substituteImagePlaceholders(rendered, filenameMap);
  const final = injectPendingIntro(substituted, introHtml);
  return { html: final, unresolvedImages: unresolved, renderWarnings: warnings };
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
  // #5086 (self-review): `argv.find((a) => !a.startsWith("--"))` — usado aqui
  // até a introdução da flag de VALOR `--send-test-to <email>` — casava com o
  // valor de QUALQUER flag de valor que apareça antes do path da edição no
  // argv (ex: `--send-test-to editor@x.com data/editions/260812` resolvia
  // editionDirArg como "editor@x.com"). `parseCliArgs` (mesmo parser de
  // `--send-test-to`) já separa positional de values corretamente — usa isso
  // em vez de reimplementar a mesma checagem de forma incompleta.
  const editionDirArg = parseCliArgs(argv).positional[0];
  const dryRun = hasFlag(argv, "dry-run");
  const reviewedCopy = hasFlag(argv, "i-reviewed-the-copy");
  const sendTest = hasFlag(argv, "send-test"); // #5086
  const sendTestTo = getStringArg(argv, "send-test-to", { example: "voce@dominio.com" }); // #5086
  const force = hasFlag(argv, "force"); // #5677 — permite criar uma 2ª campanha de propósito
  const log = (msg: string) => process.stderr.write(`[publish-daily-brevo] ${msg}\n`);

  // #4651: os process.exit() abaixo até o 1º `await` de rede (brevoGetList,
  // mais adiante) ficam como estão de propósito — nenhum fetch rodou ainda
  // neste processo nestes pontos, então não há socket keep-alive aberto que
  // dispare o crash libuv (UV_HANDLE_CLOSING) do #4638/#1401. Só os exits
  // POSTERIORES a esse await foram convertidos pra process.exitCode + return.
  if (!editionDirArg) {
    log("uso: npx tsx scripts/publish-daily-brevo.ts <edition-dir> [--dry-run] [--i-reviewed-the-copy]");
    process.exit(1);
  }
  if (!dryRun && !reviewedCopy) {
    log(
      "ERRO: fora de --dry-run, é obrigatório passar --i-reviewed-the-copy — confirmação explícita de " +
        "que o editor revisou data/snippets/brevo-diaria-pending-intro.md (ainda RASCUNHO). " +
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

  // #5086: checado cedo (pré-await, mesmo espírito do #4588 abaixo) — o
  // editor deve ver o erro de `--send-test`/`--send-test-to` já no dry-run,
  // não só quando o script for de fato criar a campanha.
  const sendTestGuard = checkSendTestGuards({ sendTest, sendTestTo, testEmail: brevoDiaria?.test_email });
  if (!sendTestGuard.ok) {
    log(`ERRO: ${sendTestGuard.reason}`);
    process.exit(1);
  }

  const editionDir = resolve(rootDir, editionDirArg);
  const content = stripGreetingAndSupporterBlocks(extractContent(editionDir));

  const imagesPath = resolvePublicImagesPath(editionDir);
  const publicImages: PublicImagesFile = existsSync(imagesPath)
    ? (JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesFile)
    : {};

  const introHtml = renderPendingIntroHtml(rootDir);
  const { html, unresolvedImages, renderWarnings } = buildDailyBrevoHtml(content, publicImages, introHtml);
  if (unresolvedImages.length > 0) {
    log(`warn: ${unresolvedImages.length} placeholder(s) de imagem sem URL: ${unresolvedImages.join(", ")}`);
  }
  // #4687 — mesmo conteúdo COMERCIAL que o caminho Beehiiv acusa via
  // `_internal/render-warnings.json` (checkRenderWarnings, Stage 4); aqui só
  // log (sem `_internal/` de edição dedicado ao Brevo) — não silencia mais.
  if (renderWarnings.length > 0) {
    log(
      `warn: ${renderWarnings.length} evento(s) de conteúdo perdido no render Brevo (#4687): ` +
        renderWarnings.map((w) => w.event).join(", "),
    );
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
    if (sendTest) {
      const testRecipient = resolveSendTestRecipient(sendTestTo, brevoDiaria?.test_email);
      const source = sendTestTo ? "--send-test-to flag" : "brevo_diaria.test_email";
      log(`  Dispatch: TEST EMAIL pra ${testRecipient} (fonte: ${source}) — não disparado em --dry-run`);
    }
    return;
  }

  // #6485: remove da lista Brevo quem já está `active` no Kit (backend de
  // envio, #6114) ANTES de contar/enviar — senão esse contato recebe a
  // edição duas vezes (Kit + esta campanha). Fail-soft de propósito: Kit
  // não configurado (`KIT_API_KEY` ausente) ou falha na API do Kit/Brevo
  // vira AVISO, nunca aborta a criação do rascunho — o guard é mitigação
  // prospectiva, não pré-condição de publicação (mesma disciplina do
  // aviso de cota de conta logo abaixo, #6146).
  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    log(`AVISO: guard de exclusão Kit-ativo (#6485) pulado — ${kitConfigResult.reason}`);
  } else {
    try {
      const exclusionResult = await applyKitActiveExclusionGuard({
        brevoApiKey: apiKey!,
        brevoListId: brevoDiaria!.list_id as number,
        kitConfig: kitConfigResult.config,
      });
      if (exclusionResult.excluded.length > 0) {
        log(
          `guard Kit-ativo (#6485): ${exclusionResult.removedFromList.length} contato(s) removido(s) da lista Brevo ` +
            `(já ativo(s) no Kit) — ${exclusionResult.excluded.join(", ")}` +
            (exclusionResult.failedToRemove.length > 0
              ? `; ${exclusionResult.failedToRemove.length} falha(s) ao remover: ${exclusionResult.failedToRemove.join(", ")}`
              : ""),
        );
      }
    } catch (e) {
      const reason = (e as Error).message;
      log(`AVISO: guard de exclusão Kit-ativo (#6485) falhou, prosseguindo sem excluir: ${reason}`);
      // #6501: o console.warn acima não é monitorado ativamente — sem isto,
      // uma falha transitória do guard passa despercebida indefinidamente.
      // Evento estruturado em data/run-log.jsonl, visível via /diaria-log.
      logEvent(
        {
          edition: basename(editionDir),
          stage: 5,
          agent: "publish-daily-brevo",
          level: "warn",
          message: "kit_exclusion_guard_failed",
          details: { reason },
        },
        rootDir,
      );
    }
  }

  const listInfo = await brevoGetList(apiKey!, brevoDiaria!.list_id as number);
  const cap = brevoDiaria!.daily_send_cap ?? 300;
  const capCheck = checkDailySendCap(listInfo.totalSubscribers, cap);
  if (!capCheck.ok) {
    log(`ERRO: ${(capCheck as { ok: false; reason: string }).reason}`);
    // Windows fix (#4651, mesma classe do #4638/#1401): process.exit() após
    // um await fetch (brevoGetList acima) derruba o processo no Windows com
    // UV_HANDLE_CLOSING enquanto o fetch agent ainda tem sockets keep-alive
    // abertos. process.exitCode + return deixa o event loop drenar sozinho.
    process.exitCode = 3;
    return;
  }

  // #6146: cota da CONTA, distinta do cap da LISTA acima. `daily_send_cap`
  // pergunta "a fila cresceu demais?"; isto pergunta "a conta ainda pode
  // enviar?". A edição 260825 passou no primeiro e morreu no segundo.
  //
  // AVISO, não abort, e de propósito: este script só cria RASCUNHO (nunca
  // `--send-now`/`--schedule-at`, #4980), então nada aqui consome cota — e,
  // mais importante, o horário do envio ainda não existe neste ponto. Barrar
  // a criação do rascunho por causa da cota de HOJE puniria o caso comum em
  // que a Etapa 5 roda antes da virada UTC e o envio cai num balde novo. O
  // gate DURO fica na Etapa 6 (`schedule-daily-brevo.ts`), que já conhece o
  // `scheduledAt` e portanto o dia certo pra consultar.
  const accountDailyLimit = resolveAccountDailyLimit(brevoDiaria!);
  const today = toStatsDay(new Date());
  try {
    const quotaSnapshot = await fetchAccountQuotaSnapshot(apiKey!, today, today);
    for (const w of describeQuotaWarnings(quotaSnapshot, accountDailyLimit)) log(`AVISO: ${w}`);
    const quotaCheck = checkAccountSendQuota({
      dailyLimit: accountDailyLimit,
      transactionalRequestsOnSendDay: quotaSnapshot.transactionalRequestsOnSendDay,
      recipients: listInfo.totalSubscribers,
    });
    if (!quotaCheck.ok) {
      log(
        `AVISO: se esta campanha fosse enviada HOJE, não caberia — ${(quotaCheck as { ok: false; reason: string }).reason} ` +
          "O rascunho vai ser criado assim mesmo (não consome cota); quem barra o agendamento é a Etapa 6.",
      );
    } else {
      log(
        `cota da conta em ${today}: ${quotaCheck.consumed}/${accountDailyLimit} consumido(s) por transacional, ` +
          `${quotaCheck.available} disponível(is), lista tem ${listInfo.totalSubscribers}.`,
      );
    }
  } catch (e) {
    // Leitura de cota é informativa nesta etapa — não pode derrubar a criação
    // do rascunho. Na Etapa 6, onde ela DECIDE, a mesma falha é bloqueante.
    log(`AVISO: não foi possível ler a cota da conta Brevo (informativo nesta etapa): ${(e as Error).message}`);
  }

  // #4517: popula o token opaco de voto (`POLL_TOKEN`) pra TODA a lista Brevo
  // ANTES de criar a campanha — paridade com a proteção Beehiiv do #4487.
  // Roda INLINE (não uma task agendada, diferente da Beehiiv). Histórico: a
  // premissa original era "a lista aqui é capada em `daily_send_cap` —
  // barato o bastante por envio" — **correção #6940**: `daily_send_cap` não
  // capa mais nada (`checkDailySendCap` esvaziado pelo #6793), então o custo
  // real depende só do tamanho atual da lista Brevo. Continua rodando
  // inline mesmo assim — garante que NUNCA falta rodar essa etapa antes de
  // um disparo real, independente do tamanho.
  const pollTokenGuard = checkPollTokenGuards({
    pollSecret: process.env.POLL_SECRET,
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareWorkersToken: process.env.CLOUDFLARE_WORKERS_TOKEN,
  });
  if (!pollTokenGuard.ok) {
    log(`ERRO: ${(pollTokenGuard as { ok: false; reason: string }).reason}`);
    // Windows fix (#4651): mesma razão do bloco acima — já houve await fetch
    // (brevoGetList) antes deste ponto.
    process.exitCode = 4;
    return;
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
    // Windows fix (#4651): já houve await fetch (brevoGetList +
    // injectPollTokenBrevo, múltiplos PATCH/POST) antes deste ponto.
    process.exitCode = 5;
    return;
  }

  // #4532 (achado HIGH): reconcilia a enumeração de `injectPollTokenBrevo`
  // contra a contagem ao vivo da lista (`listInfo`, já obtida acima pro cap
  // check) — nunca deixa uma enumeração incompleta passar como sucesso só
  // porque `failed === 0` (0 falhas sobre 0 contatos enumerados também é
  // "0 falhas").
  const reconciliation = checkContactCountReconciliation(injectionResult.total_contacts, listInfo.totalSubscribers);
  if (!reconciliation.ok) {
    log(`ERRO: ${(reconciliation as { ok: false; reason: string }).reason}`);
    // Windows fix (#4651): mesma razão dos blocos acima.
    process.exitCode = 6;
    return;
  }

  log(
    `tokens de voto (#4517): ${injectionResult.patched} patcheado(s), ` +
      `${injectionResult.skipped_already_correct} já corretos, ${injectionResult.total_contacts} contato(s) na lista.`,
  );

  // #5677: antes de criar uma campanha nova, checa se esta edição já tem uma
  // registrada em `brevo-diaria-published.json` — sem isso, rodar o script
  // 2x (ex: draft primeiro, depois `--send-test` — o fluxo normal do Passo 7
  // do SKILL.md) criava uma 2ª campanha duplicada na Brevo (achado ao vivo
  // na edição 260819, ids 24/25). `--force` cria mesmo assim, de propósito.
  const existingPublished = readBrevoDiariaPublished(editionDir);
  const createDecision = decideCreateCampaignAction(existingPublished, force);

  let campaignId: number;
  let baseState: BrevoDiariaPublished;

  if (createDecision.action === "reuse") {
    campaignId = createDecision.campaignId;
    const previousState = existingPublished!;
    log(
      `reaproveitando campanha Brevo já criada pra esta edição: id=${campaignId} (status "${previousState.status}", ` +
        `registrada em ${previousState.created_at}) — nenhuma campanha nova criada. Use --force pra criar outra de propósito.`,
    );

    // #5689: reaproveitar o campaign_id NÃO significa que o conteúdo na
    // Brevo já está em dia — subject/previewText/html continuam sendo
    // recalculados do disco em TODA invocação (achado do #5687: uma 2ª
    // invocação depois do editor corrigir 02-reviewed.md/03-social.md
    // mandava --send-test com o conteúdo V1 antigo, silenciosamente). PUT
    // roda incondicionalmente aqui (idempotente — sobrescrever com o mesmo
    // conteúdo é barato) ANTES de qualquer --send-test reaproveitar o id.
    const diverges = campaignContentDiverges({
      existingSubject: previousState.subject,
      existingPreviewText: previousState.preview_text,
      newSubject: subject,
      newPreviewText: previewText,
    });
    if (diverges) {
      log(
        `AVISO: conteúdo recalculado diverge do registrado na campanha ${campaignId} — ` +
          `subject/preview mudaram desde a última invocação. Atualizando via PUT antes de prosseguir.`,
      );
    }
    await brevoPut(apiKey!, `/emailCampaigns/${campaignId}`, {
      subject,
      previewText,
      htmlContent: html,
    });
    log(`campanha ${campaignId} atualizada via PUT com o conteúdo recalculado desta invocação.`);

    baseState = { ...previousState, subject, preview_text: previewText };
    // #5689: persiste subject/preview_text atualizados mesmo sem --send-test
    // — senão a PRÓXIMA invocação comparia contra o registro antigo de novo
    // (campaignContentDiverges nunca veria a divergência já corrigida).
    writeBrevoDiariaPublished(editionDir, baseState);
  } else {
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
    campaignId = campaignResp.id;
    log(`campanha criada: id=${campaignId} (rascunho — schedule/send é ação manual separada, mesma cautela do publisher mensal)`);

    // #5677: persiste o estado "draft" já aqui — ANTES de qualquer
    // --send-test — pra que uma invocação futura (com ou sem --send-test)
    // consiga detectar que a campanha já existe em vez de criar outra.
    baseState = buildDraftPublishedState({
      campaignId,
      subject,
      previewText,
      listId: brevoDiaria!.list_id as number,
      createdAt: new Date().toISOString(),
    });
    writeBrevoDiariaPublished(editionDir, baseState);
  }

  // #5086: --send-test, espelhando publish-monthly.ts — dispara DEPOIS do
  // rascunho existir (sendTest do Brevo opera sobre um campaign_id já criado).
  // sendTestGuard (checado antes de qualquer await) já garantiu que o
  // destinatário resolve sem lançar.
  if (sendTest) {
    const testRecipient = resolveSendTestRecipient(sendTestTo, brevoDiaria!.test_email);
    await brevoPost(apiKey!, `/emailCampaigns/${campaignId}/sendTest`, { emailTo: [testRecipient] });
    const testSentAt = new Date().toISOString();
    const source = sendTestTo ? "--send-test-to flag" : "brevo_diaria.test_email";
    log(`Email de teste enviado para: ${testRecipient} (fonte: ${source})`);

    // #5677: mescla sobre `baseState` (draft recém-criado OU reaproveitado)
    // em vez de montar do zero — preserva campaign_id/subject/preview_text/
    // list_id/created_at do estado anterior.
    const published = buildTestSentPublishedState(baseState, testRecipient, testSentAt);
    writeBrevoDiariaPublished(editionDir, published);
    log(`estado do teste salvo em ${brevoDiariaPublishedPath(editionDir)}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[publish-daily-brevo] erro fatal: ${(e as Error).message}\n`);
    // Windows fix (#4651, mesma classe do #4638/#1401): main() pode lançar
    // depois de já ter feito await fetch (brevoGetList/brevoPost/injectPollTokenBrevo)
    // — process.exit() aqui arriscaria o mesmo crash libuv.
    process.exitCode = 1;
  });
}
