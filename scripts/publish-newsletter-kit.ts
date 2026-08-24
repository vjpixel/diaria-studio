#!/usr/bin/env node
/**
 * scripts/publish-newsletter-kit.ts (#464 — reescrever publish-newsletter para Kit API, #461)
 *
 * Publisher da newsletter diária via Kit REST API — substitui, atrás da
 * flag `platform.publishing.newsletter.backend` (`platform.config.json`,
 * default `"beehiiv"`), o playbook Chrome-automation de
 * `context/publishers/beehiiv-playbook.md`. Beehiiv continua funcional em
 * paralelo — trocar o valor da flag é o único gate de switchover.
 *
 * ## Por que isto é possível (achado do #6047/#464)
 *
 * Ao contrário da Beehiiv (sem API de publicação no plano Launch/free —
 * daí o playbook via browser), o Kit tem broadcasts com API REST completa:
 * criar, atualizar metadados, agendar, tudo via `kit-broadcasts.ts`. Isso
 * elimina a classe inteira de bug do #39/#275 (browser automation) — mas
 * só se `subject`/`preview_text`/`thumbnail_url` puderem ser derivados
 * automaticamente, senão a Etapa 5 ainda precisaria de um passo manual.
 * Confirmado que dá: `buildKitSubject`/`buildKitPreviewText` abaixo
 * reusam o bloco TÍTULO/SUBTÍTULO que `insert-titulo-subtitulo.ts` já
 * grava no topo do `02-reviewed.md` desde o #916 (hoje consumido só pelo
 * passo manual do Beehiiv) — mesma derivação de `buildDailyBrevoSubject`/
 * `buildDailyBrevoPreviewText` (`publish-daily-brevo.ts`), mantida como
 * função própria aqui (não importada de lá) seguindo a convenção já usada
 * pelos outros publishers: cada ESP dono do seu builder, mesmo quando a
 * lógica coincide — desacopla mudanças futuras específicas de um canal.
 *
 * ## Sem test-send nativo — mecanismo de substituto (achado ao vivo #464)
 *
 * A API do Kit não tem endpoint de test email (só draft/schedule/publish).
 * `--send-test` aqui cria um broadcast SEPARADO E DESCARTÁVEL (nunca o
 * broadcast real que vai ao ar) com o MESMO subject/content/preview,
 * escopado via `subscriber_filter` só à tag `diaria-test-email`
 * (`kit-broadcasts.ts::resolveTestSendTagId`/`buildTestSendFilter`), e
 * `send_at` = agora. Confirmado ao vivo: entrega em segundos na caixa do
 * editor (não spam), 1 destinatário exato.
 *
 * **Por que um broadcast SEPARADO, não o real com `subscriber_filter`
 * trocado temporariamente:** uma vez que um broadcast tem `send_at`
 * setado e dispara, ele vira `completed` e fica PERMANENTE — confirmado
 * ao vivo que `DELETE`/update num broadcast `completed` falha com 422
 * "Broadcast has already been sent." Se o test-send reusasse o broadcast
 * real (só trocando `subscriber_filter` pra tag de teste e `send_at` pra
 * agora), esse broadcast ficaria `completed` PARA SEMPRE — nunca mais
 * poderia ser reagendado pra audiência real na Etapa 6. Por isso o
 * broadcast de produção (rastreado em `_internal/newsletter-kit-published.json`)
 * nunca leva `send_at` até a Etapa 6 de verdade — só os disposable de teste.
 *
 * ## Fragmento, não documento completo (achado ao vivo #464)
 *
 * `renderHTML(content, { esp: "kit", fullDocument: false })` — NÃO
 * `fullDocument: true`. Confirmado ao vivo contra 3 broadcasts de teste:
 * o Kit SEMPRE embrulha `content` no próprio shell (`<div class="email">`
 * + footer de unsubscribe + pixel de abertura) e DESCARTA qualquer
 * `<!doctype>`/`<head>`/`<body>` que vier no payload — exatamente como a
 * Beehiiv trata o fragmento colado no editor. `fullDocument: true` gastaria
 * bytes num shell que o Kit joga fora sem aviso — `fullDocument: false` é
 * o formato correto, mesmo padrão do fragmento Beehiiv.
 *
 * **O `<style>` não é descartado cru — é INLINED e depois removido.**
 * Testado tanto dentro de `<head>` quanto como tag solta (sibling do
 * conteúdo, sem `<head>` — o formato que `fullDocument:false` já emite):
 * nos dois casos a tag `<style>` desaparece da entrega, mas as regras cujo
 * seletor casa com um elemento (classe/tag) são INLINED nesse elemento
 * ANTES da tag ser removida — confirmado ao vivo com `.probe2{color:...
 * !important; font-family:...}` virando `style="...;font-family:Georgia,
 * serif;color:rgb(9,9,9) !important"` no HTML entregue (`!important`
 * preservado). Comportamento de um inliner CSS→inline (padrão "juice"),
 * não descarte simples. Consequência: regras de seletor simples (classe/
 * tag) sobrevivem via inlining; o que não dá pra achatar em `style=""`
 * (`@media`, pseudo-classes/elementos) morre junto com a tag — `DS_STYLE_BLOCK`
 * não foi auditado regra-a-regra contra essa restrição ainda.
 *
 * Kit também injeta um baseline inline (`margin:1em 0;font-family:...;
 * color:#2d2d2f;font-size:16px;line-height:1.5`) em TODO `<p>` — mas
 * SEMPRE como prefixo, nunca sobrescrevendo: qualquer propriedade que o
 * nosso HTML já declare inline no mesmo `<p>` (direto ou via o inlining
 * acima) vem DEPOIS no atributo `style`, então vence pela regra de cascata
 * CSS (last-wins dentro do mesmo atributo `style`). Confirmado ao vivo com
 * `color`/`font-family` (nossos valores venceram) e `background`/`padding`
 * (sem conflito, os dois sobreviveram). **NÃO CALIBRADO** ainda contra um
 * envio de produção completo — ver docstring de `P_PAD_BY_ESP`/
 * `P_MARGIN_FACTOR_BY_ESP` em `newsletter-render-html.ts`.
 *
 * ## Merge tag do voto do É IA?
 *
 * `esp: "kit"` usa `{{ subscriber.email_address }}` (Liquid, cru — mesmo
 * eixo de identidade do Beehiiv, sem token). Ver docstring de `Esp` em
 * `newsletter-render-html.ts`.
 *
 * Uso:
 *   npx tsx scripts/publish-newsletter-kit.ts <edition-dir> --dry-run
 *   npx tsx scripts/publish-newsletter-kit.ts <edition-dir>
 *   npx tsx scripts/publish-newsletter-kit.ts <edition-dir> --send-test
 *
 * Exit codes: 1 uso/erro fatal genérico; 2 config/flag ausente ou backend
 * != "kit"; 7 assunto vazio (`content.title` ausente).
 *
 * Idempotência: `<edition-dir>/_internal/newsletter-kit-published.json` é
 * escrito assim que o draft é criado — uma invocação seguinte pra MESMA
 * edição atualiza (`updateBroadcast`) o mesmo `broadcast_id` em vez de
 * criar um 2º draft (mesmo padrão de `publish-daily-brevo.ts` #5677).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { extractContent, type NewsletterContent } from "./lib/newsletter-parse.ts";
import { renderHTMLWithWarnings, type RenderWarningEvent } from "./lib/newsletter-render-html.ts";
import { buildFilenameMap, substituteImagePlaceholders, type PublicImagesFile } from "./substitute-image-urls.ts";
import {
  createBroadcast,
  updateBroadcast,
  resolveTestSendTagId,
  buildTestSendFilter,
  buildAllSubscribersFilter,
} from "./lib/kit-broadcasts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── subject/preview (puro) ───────────────────────────────────────────────
// Mesma derivação de `buildDailyBrevoSubject`/`buildDailyBrevoPreviewText`
// (publish-daily-brevo.ts) — mantida como função própria, não importada de
// lá, seguindo a convenção de cada publisher dono do seu builder (ver
// docstring do módulo).

/** Pura — assunto derivado do título do D1 (mesma fonte que o passo manual
 *  do Beehiiv usa hoje via `insert-titulo-subtitulo.ts`, #916). */
export function buildKitSubject(content: Pick<NewsletterContent, "title">): string {
  return content.title;
}

/** Pura — preview text a partir do subtítulo. */
export function buildKitPreviewText(content: Pick<NewsletterContent, "subtitle">): string {
  return content.subtitle;
}

export type SubjectPresenceCheck = { ok: true } | { ok: false; reason: string };

export function checkSubjectNotEmpty(subject: string): SubjectPresenceCheck {
  if (subject.trim() === "") {
    return { ok: false, reason: "assunto vazio (content.title em branco)" };
  }
  return { ok: true };
}

// ── HTML (puro) ──────────────────────────────────────────────────────────

/**
 * Monta o HTML final pro `content` do broadcast — fragmento (não documento
 * completo, ver docstring do módulo) + substituição de `{{IMG:filename}}`
 * via `06-public-images.json` (mesmo mapa ESP-agnóstico que Beehiiv/Brevo
 * já usam, `substitute-image-urls.ts`).
 */
export function buildKitHtml(
  content: NewsletterContent,
  publicImages: PublicImagesFile,
): { html: string; unresolvedImages: string[]; renderWarnings: RenderWarningEvent[] } {
  const { html: rendered, warnings } = renderHTMLWithWarnings(content, { esp: "kit", fullDocument: false });
  const filenameMap = buildFilenameMap(publicImages.images ?? {});
  const { html: substituted, unresolved } = substituteImagePlaceholders(rendered, filenameMap);
  return { html: substituted, unresolvedImages: unresolved, renderWarnings: warnings };
}

// ── estado de publicação (idempotência, mesmo padrão de #5677) ──────────

export interface KitNewsletterPublished {
  broadcast_id: number;
  subject: string;
  preview_text: string;
  status: "draft" | "test_sent" | "scheduled";
  test_broadcast_ids?: number[];
  scheduled_at?: string;
}

export function resolvePublishedStatePath(editionDir: string): string {
  return resolve(editionDir, "_internal", "newsletter-kit-published.json");
}

export function readPublishedState(editionDir: string): KitNewsletterPublished | null {
  const path = resolvePublishedStatePath(editionDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as KitNewsletterPublished;
}

export function writePublishedState(editionDir: string, state: KitNewsletterPublished): void {
  const path = resolvePublishedStatePath(editionDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

// ── platform.config.json (leitura mínima) ─────────────────────────────

interface PlatformConfig {
  publishing?: {
    newsletter?: {
      backend?: string;
    };
  };
}

export type BackendCheck = { ok: true } | { ok: false; reason: string };

/** Pura — recusa rodar se a flag não estiver em "kit" (achado #464: script
 *  standalone pode ser invocado por engano fora do switchover). */
export function checkKitBackendEnabled(platformConfig: PlatformConfig): BackendCheck {
  const backend = platformConfig.publishing?.newsletter?.backend ?? "beehiiv";
  if (backend !== "kit") {
    return {
      ok: false,
      reason: `platform.config.json → publishing.newsletter.backend = "${backend}", não "kit" — este script só roda com o backend Kit selecionado.`,
    };
  }
  return { ok: true };
}

// ── main ──────────────────────────────────────────────────────────────

export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const editionDirArg = parseCliArgs(argv).positional[0];
  const dryRun = hasFlag(argv, "dry-run");
  const sendTest = hasFlag(argv, "send-test");
  const log = (msg: string) => process.stderr.write(`[publish-newsletter-kit] ${msg}\n`);

  if (!editionDirArg) {
    log("uso: npx tsx scripts/publish-newsletter-kit.ts <edition-dir> [--dry-run] [--send-test]");
    process.exitCode = 1;
    return;
  }

  const platformConfig = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as PlatformConfig;
  const backendCheck = checkKitBackendEnabled(platformConfig);
  if (!backendCheck.ok) {
    log(`ERRO: ${backendCheck.reason}`);
    process.exitCode = 2;
    return;
  }

  const editionDir = resolve(rootDir, editionDirArg);
  const content = extractContent(editionDir);

  const imagesPath = resolve(editionDir, "06-public-images.json");
  const publicImages: PublicImagesFile = existsSync(imagesPath)
    ? (JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesFile)
    : {};

  const { html, unresolvedImages, renderWarnings } = buildKitHtml(content, publicImages);
  if (unresolvedImages.length > 0) {
    log(`warn: ${unresolvedImages.length} placeholder(s) de imagem sem URL: ${unresolvedImages.join(", ")}`);
  }
  if (renderWarnings.length > 0) {
    log(`warn: ${renderWarnings.length} evento(s) de conteúdo perdido no render Kit: ${renderWarnings.map((w) => w.event).join(", ")}`);
  }

  const subject = buildKitSubject(content);
  const previewText = buildKitPreviewText(content);

  const subjectCheck = checkSubjectNotEmpty(subject);
  if (!subjectCheck.ok) {
    log(`ERRO: ${subjectCheck.reason} — abortando antes de criar o broadcast. Verifique ${editionDir}/02-reviewed.md.`);
    process.exitCode = 7;
    return;
  }

  if (dryRun) {
    log(`[dry-run] subject: "${subject}"`);
    log(`[dry-run] preview_text: "${previewText}"`);
    log(`[dry-run] html: ${html.length} bytes`);
    return;
  }

  const existing = readPublishedState(editionDir);
  let broadcastId: number;
  if (existing) {
    log(`draft já existe (broadcast_id=${existing.broadcast_id}) — atualizando em vez de criar um 2º.`);
    const updated = await updateBroadcast(existing.broadcast_id, {
      subject,
      preview_text: previewText,
      content: html,
    });
    broadcastId = updated.id;
  } else {
    const created = await createBroadcast({
      subject,
      content: html,
      preview_text: previewText,
      send_at: null, // rascunho — Etapa 6 é quem agenda de verdade
      subscriber_filter: buildAllSubscribersFilter(),
    });
    broadcastId = created.id;
    log(`draft criado: broadcast_id=${broadcastId}`);
  }

  const state: KitNewsletterPublished = {
    broadcast_id: broadcastId,
    subject,
    preview_text: previewText,
    status: "draft",
    test_broadcast_ids: existing?.test_broadcast_ids ?? [],
  };

  if (sendTest) {
    // #464: broadcast SEPARADO e descartável — nunca o de produção (ver
    // docstring do módulo sobre por que reusar o real corromperia a Etapa 6).
    const tagId = await resolveTestSendTagId();
    const sendAt = new Date(Date.now() + 15_000).toISOString();
    const testBroadcast = await createBroadcast({
      subject: `[teste] ${subject}`,
      content: html,
      preview_text: previewText,
      send_at: sendAt,
      subscriber_filter: buildTestSendFilter(tagId),
    });
    log(`test-send disparado: broadcast_id=${testBroadcast.id} (descartável, agendado pra ${sendAt})`);
    state.status = "test_sent";
    state.test_broadcast_ids = [...(state.test_broadcast_ids ?? []), testBroadcast.id];
  }

  writePublishedState(editionDir, state);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[publish-newsletter-kit] erro fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
