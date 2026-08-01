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
 *      Stage 4 diário.
 *   2. `renderHTML(content, { esp: "brevo", fullDocument: true })` — variante
 *      Brevo já wired desde #4266 item 1 (merge tag `{{ contact.EMAIL }}`).
 *   3. Substituição de imagem via `_internal/06-public-images.json` — MESMO
 *      mapa que o publisher Beehiiv usa (URLs públicas são ESP-agnósticas,
 *      não precisa reupload).
 *   4. Injeção do bloco de intro OBRIGATÓRIO do segmento Pending
 *      (`brevo-diaria-intro.ts`, #4266 item 5) — recusa publicar sem ele.
 *   5. Cap de envio diário (`brevo_diaria.daily_send_cap`, default 300) —
 *      GUARD de segurança, não rotação de ondas: se a lista Brevo tiver mais
 *      assinantes que o cap, o script ABORTA em vez de enviar uma fatia
 *      arbitrária ou estourar o cap. Construir rotação por ondas (como
 *      `clarice-build-waves-store.ts` faz pra Clarice) é trabalho futuro,
 *      fora do escopo desta unidade — ver PR body.
 *   6. Cria a campanha Brevo (`POST /emailCampaigns`) — sem `--send-now`/
 *      `--schedule-at`, fica como rascunho na conta Brevo (mesma cautela do
 *      publisher mensal: nunca dispara sozinho).
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
 * Como do PR #4398 (260731), ainda não rodado com efeito real (guard de
 * publicação — scripts que tocam Beehiiv/Brevo ao vivo não rodam a partir de
 * sessão autônoma). Validado só via testes com fetch mockado + fixtures.
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

// ── subject/preview (puro) ──────────────────────────────────────────────

/**
 * Pura — assunto derivado do título do D1 (não há um "ASSUNTO" dedicado no
 * template diário, diferente do mensal — a diária usa metadados manuais na
 * UI do Beehiiv, CLAUDE.md §Publicadores). Formato escolhido:
 * "Diar.ia — {título do D1}". Decisão de design (não veio da issue) — o
 * editor pode ajustar depois via `--subject-override` sem mudar código.
 */
export function buildDailyBrevoSubject(content: Pick<NewsletterContent, "title">): string {
  return `Diar.ia — ${content.title}`;
}

/** Pura — preview text a partir do subtítulo (mesmo campo usado como "por
 * que isso importa" resumido nas outras plataformas de publicação). */
export function buildDailyBrevoPreviewText(content: Pick<NewsletterContent, "subtitle">): string {
  return content.subtitle;
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

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
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

  const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as PlatformConfig;
  const brevoDiaria = platformConfig.brevo_diaria;
  const apiKey = brevoDiaria ? process.env[brevoDiaria.api_key_env] : undefined;
  const guardCheck = checkBrevoDiariaGuards({ dryRun, brevoDiaria, apiKey });
  if (!guardCheck.ok) {
    log(`ERRO: ${guardCheck.reason}`);
    process.exit(2);
  }

  const editionDir = resolve(ROOT, editionDirArg);
  const content = extractContent(editionDir);

  const imagesPath = resolve(editionDir, "_internal/06-public-images.json");
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

  const campaignResp = (await brevoPost(apiKey!, "/emailCampaigns", {
    name: `Diar.ia diária — ${new Date().toISOString().slice(0, 16)}`,
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
