#!/usr/bin/env node
/**
 * scripts/publish-newsletter-kit.ts (#464 — reescrever publish-newsletter para Kit API, #461)
 *
 * Publisher da newsletter diária via Kit REST API — pensado pra eventualmente
 * substituir, atrás da flag `platform.publishing.newsletter.backend`
 * (`platform.config.json`, default `"beehiiv"`), o playbook Chrome-automation
 * de `context/publishers/beehiiv-playbook.md`. **Estado real nesta PR
 * (achado do review, #6080): a flag só é lida por `checkKitBackendEnabled`
 * AQUI DENTRO, como guard contra invocação acidental deste script fora de
 * um switchover deliberado — o orchestrator/Stage 5
 * (`.claude/agents/orchestrator-stage-5.md`) NÃO lê essa flag nem dispatcha
 * pra este script ainda.** Trocar o valor pra `"kit"` hoje não muda nada no
 * `/diaria-5-publicacao` — só habilita rodar este script standalone. Wiring
 * do dispatch automático é trabalho futuro, fora do escopo desta PR.
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
 * **Pré-requisito manual de `--send-test` (achado do review, PR #6080):**
 * `resolveTestSendTagId` só resolve/cria a TAG `diaria-test-email` — quem
 * precisa estar MARCADO com ela é o subscriber do editor
 * (`EDITOR_COPY_EMAIL`, `scripts/lib/editor-copy.ts`), e isso hoje é
 * manual (feito 1x via `kit-broadcasts.ts::tagSubscriber`/curl direto, não
 * automatizado por este script). Sem o subscriber tagueado, `--send-test`
 * cria e dispara o broadcast descartável normalmente, mas ele não alcança
 * ninguém (`subscriber_filter` vazio na prática). Automatizar essa etapa
 * (resolver o subscriber por e-mail + tagueá-lo se ainda não estiver) é
 * trabalho futuro, não coberto nesta PR.
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
  aplicarCreditoKit,
  contemResiduoBeehiiv,
  type CreditoOptions,
} from "./lib/shared/sending-platform-credit.ts"; // #6195
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
  opts: CreditoOptions = {},
): {
  html: string;
  unresolvedImages: string[];
  renderWarnings: RenderWarningEvent[];
  /**
   * `false` quando nenhum crédito da Beehiiv foi achado no bloco "Para
   * encerrar". Diagnóstico, não guard. `undefined` quando a edição não tem
   * bloco "Para encerrar".
   */
  creditoSubstituido: boolean | undefined;
  /**
   * **O guard (achado P0 do review #6207).** `true` = sobrou menção à
   * concorrente no HTML que vai pelo Kit. Checa o INVARIANTE, não se a
   * substituição achou o padrão — é o que sobrevive à reescrita da
   * Clarice/humanizador sobre o parágrafo (precedente #1982).
   */
  residuoBeehiiv: boolean;
} {
  // #6195 — o markdown stitchado credita a Beehiiv (com link de afiliado
  // dela). Numa edição enviada pelo Kit isso é falso, e o link é da
  // concorrente. Trocamos AQUI porque o stitch não sabe o canal e este é o
  // ponto onde `esp: "kit"` já existe.
  let creditoSubstituido: boolean | undefined;
  let contentParaRender = content;
  if (typeof content.encerrar === "string" && content.encerrar.length > 0) {
    const r = aplicarCreditoKit(content.encerrar, opts);
    creditoSubstituido = r.substituido;
    if (r.substituido) contentParaRender = { ...content, encerrar: r.markdown };
  }

  const { html: rendered, warnings } = renderHTMLWithWarnings(contentParaRender, {
    esp: "kit",
    fullDocument: false,
  });
  const filenameMap = buildFilenameMap(publicImages.images ?? {});
  const { html: substituted, unresolved } = substituteImagePlaceholders(rendered, filenameMap);
  return {
    html: substituted,
    unresolvedImages: unresolved,
    renderWarnings: warnings,
    creditoSubstituido,
    residuoBeehiiv: contemResiduoBeehiiv(substituted),
  };
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

export interface KitAffiliateConfig {
  /** #6195 — vazio ⇒ crédito neutro nas edições Kit. Ver `sending-platform-credit.ts`. */
  affiliate_url?: string;
  affiliate_offer_text?: string;
}

interface PlatformConfig {
  publishing?: {
    newsletter?: {
      backend?: string;
    };
  };
  /** #6195 — crédito de plataforma no rodapé das edições Kit. */
  kit?: KitAffiliateConfig;
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

  const { html, unresolvedImages, renderWarnings, creditoSubstituido, residuoBeehiiv } = buildKitHtml(
    content,
    publicImages,
    { kitAffiliateUrl: platformConfig.kit?.affiliate_url, kitOfferText: platformConfig.kit?.affiliate_offer_text },
  );
  if (creditoSubstituido === false) {
    log("[#6195] aviso: nenhum crédito da Beehiiv achado no 'Para encerrar' — nada a trocar.");
  }
  if (residuoBeehiiv) {
    log(
      "[#6195] ERRO: o HTML do Kit ainda menciona a Beehiiv. A copy do rodapé provavelmente " +
        "foi reescrita (Clarice/humanizador, precedente #1982) e a âncora não casou. " +
        "Recusando publicar o link da concorrente numa edição do Kit.",
    );
    process.exitCode = 8;
    return;
  }
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
  let publicUrl: string | undefined;
  if (existing) {
    log(`draft já existe (broadcast_id=${existing.broadcast_id}) — atualizando em vez de criar um 2º.`);
    const updated = await updateBroadcast(existing.broadcast_id, {
      subject,
      preview_text: previewText,
      content: html,
    });
    broadcastId = updated.id;
    publicUrl = updated.public_url;
  } else {
    const created = await createBroadcast({
      subject,
      content: html,
      preview_text: previewText,
      send_at: null, // rascunho — Etapa 6 é quem agenda de verdade
      subscriber_filter: buildAllSubscribersFilter(),
    });
    broadcastId = created.id;
    publicUrl = created.public_url;
    log(`draft criado: broadcast_id=${broadcastId}`);
  }

  // #464 (achado do review, PR #6080): grava o estado do draft REAL
  // imediatamente após criá-lo/atualizá-lo — ANTES do bloco `--send-test`
  // abaixo, que faz sua PRÓPRIA chamada de rede (`createBroadcast` pro
  // broadcast descartável). Mesmo padrão de `publish-daily-brevo.ts`
  // (#5677): se a chamada de test-send falhar depois daqui (rede, 429
  // esgotado, `resolveTestSendTagId` falha), o `broadcast_id` do draft real
  // já está persistido — uma invocação seguinte reaproveita (`updateBroadcast`)
  // em vez de criar um 2º draft de produção. Gravar só no fim (como antes)
  // perderia esse registro e duplicaria o draft real na próxima tentativa.
  // #464 (achado do review, PR #6080): `status` herda de `existing?.status`,
  // não hardcoded "draft" — senão uma invocação de atualização de conteúdo
  // (sem `--send-test`) DEPOIS de um test-send anterior regride silenciosamente
  // `"test_sent"` pra `"draft"`, apesar de `test_broadcast_ids` continuar
  // correto. O fato "já mandei teste pra essa edição" não deve se perder só
  // porque o editor pediu pra atualizar o conteúdo do draft.
  const state: KitNewsletterPublished = {
    broadcast_id: broadcastId,
    subject,
    preview_text: previewText,
    status: existing?.status ?? "draft",
    test_broadcast_ids: existing?.test_broadcast_ids ?? [],
  };
  writePublishedState(editionDir, state);

  // #464 (Stage 5 wiring): `05-edition-url.txt` é o mesmo artefato que o
  // playbook Beehiiv grava (ver orchestrator-stage-5.md §5c-1) — consumido
  // por publish-linkedin/publish-facebook/publish-instagram (substituição
  // de `{edition_url}` em `03-social.md`) e pelo `post_pixel` do Stage 6.
  // `public_url` do broadcast Kit é o equivalente direto. Roda DEPOIS de
  // `writePublishedState` acima (achado do review, PR #6096): o
  // `broadcast_id` do draft real precisa estar persistido ANTES de
  // qualquer I/O secundário que possa falhar — senão um erro de disco
  // aqui (cheio, permissão) propagaria pra fora de `main()` sem o estado
  // do draft ter sido salvo, e uma invocação seguinte veria `existing =
  // null` e criaria um 2º draft de produção (exatamente o bug que a
  // ordem "estado primeiro" logo acima já existe pra evitar). Try/catch
  // dedicado torna esse fail-soft real, não só uma checagem de valor
  // vazio — nenhuma falha aqui propaga pra fora de `main()`.
  try {
    if (publicUrl) {
      const internalDir = resolve(editionDir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(resolve(internalDir, "05-edition-url.txt"), publicUrl);
    } else {
      // #464: nunca confirmado ao vivo que o Kit sempre popula `public_url`
      // (ver docstring de `KitBroadcastDetail` em kit-client.ts) — se
      // acontecer de verdade, o orchestrator (§5c-2) trata a ausência
      // deste arquivo como sinal pra warning explícito, nunca cai no
      // fallback de URL Beehiiv (domínio errado pro Kit).
      log("warn: broadcast sem public_url — 05-edition-url.txt não gravado.");
    }
  } catch (e) {
    log(`warn: falha ao gravar 05-edition-url.txt (${e instanceof Error ? e.message : String(e)}) — draft/estado já persistidos, artefato secundário não gravado.`);
  }

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
    writePublishedState(editionDir, state);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[publish-newsletter-kit] erro fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
