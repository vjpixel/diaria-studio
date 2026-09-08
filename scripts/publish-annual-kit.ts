#!/usr/bin/env npx tsx
/**
 * publish-annual-kit.ts (#7569) — Etapa 5 da `/diaria-anual`.
 *
 * Cria o broadcast da edição ANUAL na base própria (Kit), **sempre como
 * rascunho**. Nada aqui envia nem agenda: o disparo continua sendo ação
 * humana, mesma disciplina do Stage 5/6 do diário.
 *
 * ## Por que não reusa `publish-newsletter-kit.ts`
 *
 * Aquele script deriva subject, preview e HTML do `02-reviewed.md` de uma
 * edição DIÁRIA, via `newsletter-parse.ts` — um formato que a anual não tem
 * (nem destaques D1/D2/D3, nem seções de lista, nem "É IA?"). O que os dois
 * compartilham é a camada Kit, e é ela que este script reusa
 * (`lib/kit-broadcasts.ts`): mesma criação de broadcast, mesmo test-send por
 * broadcast descartável, mesma idempotência por arquivo de estado.
 *
 * ## Envio EXTRA, não substituto
 *
 * A anual sai ao lado da edição diária do dia (decisão do editor,
 * 07/09/2026) — dois e-mails para a mesma base no mesmo dia. Este script não
 * toca em nada do fluxo diário.
 *
 * Uso:
 *   npx tsx scripts/publish-annual-kit.ts --slug 2026-aniversario --dry-run
 *   npx tsx scripts/publish-annual-kit.ts --slug 2026-aniversario
 *   npx tsx scripts/publish-annual-kit.ts --slug 2026-aniversario --send-test
 *
 * Exit codes: 0 ok · 1 uso/erro · 2 backend != "kit" · 3 lint crítico · 7 assunto vazio.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  createBroadcast,
  updateBroadcast,
  buildAllSubscribersFilter,
  buildTestSendFilter,
  resolveTestSendTagId,
} from "./lib/kit-broadcasts.ts";
import { annualPaths, themeIndexFromImageFilename } from "./lib/anual/annual-paths.ts";
import { parseAnnualDraft } from "./lib/anual/annual-parse.ts";
import { renderAnnualEmail } from "./lib/anual/annual-render.ts";
import { relinkAnnualEditionHtml } from "./lib/anual/annual-relink.ts";
import { loadUnifiedEditionCache } from "./lib/shared/edition-cache-reader.ts";
import { lintAnnualDraft } from "./lint-annual-draft.ts";
import { tipoFromSlug, type AnnualTipo } from "./lib/anual/annual-window.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `_internal/02-chosen-subject.txt` guarda a linha INTEIRA do bloco ASSUNTO
 * escolhida (#7587 item 6) — inclusive o prefixo numérico do markdown
 * (`1. Manchete do ano`), porque quem grava o arquivo copia a linha como
 * está. Ler cru manda o prefixo pro assunto real do e-mail. Defesa no
 * CONSUMIDOR (preferível a mudar quem grava, por decisão do editor na
 * issue): normaliza aqui, tirando `N. ` do início se presente.
 */
export function normalizeChosenSubject(raw: string): string {
  return raw.trim().replace(/^\d+\.\s*/, "").trim();
}

export interface AnnualPublishedState {
  slug: string;
  broadcast_id: number;
  public_url?: string;
  subject: string;
  status: "draft" | "test_sent";
  test_broadcast_ids: number[];
  created_at: string;
  updated_at: string;
}

/** Guard do #5608: nenhuma execução deste script deve autenticar pela API paga. */
export function checkKitBackend(config: { publishing?: { newsletter?: { backend?: string } } }): {
  ok: boolean;
  reason?: string;
} {
  const backend = config.publishing?.newsletter?.backend;
  if (backend !== "kit") {
    return {
      ok: false,
      reason: `publishing.newsletter.backend = ${JSON.stringify(backend)} — este script só roda com "kit".`,
    };
  }
  return { ok: true };
}

/**
 * Lê o estado do broadcast já criado.
 *
 * **Arquivo ausente e arquivo ilegível NÃO são a mesma coisa.** Ausente é o
 * primeiro run (devolve `null`, e o fluxo cria o rascunho). Ilegível é
 * corrupção — escrita truncada por processo morto no meio, conflito de sync
 * do OneDrive, encoding — e tratá-la como "ainda não existe" faz o script
 * criar um SEGUNDO rascunho da mesma edição no Kit, quebrando em silêncio a
 * idempotência que a skill promete. Por isso corrupção lança: é melhor o
 * editor olhar o arquivo do que descobrir dois broadcasts depois.
 */
export function readState(path: string): AnnualPublishedState | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw) as Partial<AnnualPublishedState>;
    // JSON válido não basta: um arquivo truncado para `{}` passaria no parse
    // e levaria `updateBroadcast(undefined, ...)` adiante. O `broadcast_id` é
    // o único campo sem o qual o estado não serve pra nada.
    if (typeof parsed?.broadcast_id !== "number") {
      throw new Error("sem `broadcast_id` numérico");
    }
    return parsed as AnnualPublishedState;
  } catch (err) {
    throw new Error(
      `${path} existe mas não é JSON válido (${(err as Error).message}). ` +
        `Seguir daqui criaria um 2º rascunho da mesma edição no Kit. ` +
        `Verifique o arquivo — se o broadcast não existe mesmo, apague-o e rode de novo.`,
    );
  }
}

export async function main(argv: string[] = process.argv.slice(2), rootDir: string = ROOT): Promise<void> {
  const args = parseCliArgs(argv);
  const log = (m: string) => process.stderr.write(`[publish-annual-kit] ${m}\n`);
  const slug = args.values.slug;
  const dryRun = hasFlag(argv, "dry-run");
  const sendTest = hasFlag(argv, "send-test");

  if (!slug) {
    log("uso: --slug 2026-aniversario [--dry-run] [--send-test]");
    process.exitCode = 1;
    return;
  }

  const platformConfig = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8"));
  const backendCheck = checkKitBackend(platformConfig);
  if (!backendCheck.ok) {
    log(`ERRO: ${backendCheck.reason}`);
    process.exitCode = 2;
    return;
  }

  const paths = annualPaths(slug, resolve(rootDir, "data/annual"));
  if (!existsSync(paths.draft)) {
    log(`draft não encontrado: ${paths.draft}`);
    process.exitCode = 1;
    return;
  }

  const tipo = tipoFromSlug(slug);
  const md = readFileSync(paths.draft, "utf8");

  // O lint roda de novo AQUI, não só na Etapa 2/4: o draft pode ter sido
  // editado depois do gate (pelo editor, no Studio ou local), e este é o
  // último ponto antes de o conteúdo virar um broadcast real.
  const lint = lintAnnualDraft(md, tipo);
  if (!lint.ok) {
    for (const e of lint.errors) log(`ERRO de lint: ${e}`);
    log("recusando publicar — corrija o draft e rode de novo.");
    process.exitCode = 3;
    return;
  }
  const draft = parseAnnualDraft(md);
  const subject = normalizeChosenSubject(
    existsSync(paths.chosenSubject) ? readFileSync(paths.chosenSubject, "utf8") : (draft.subjects[0] ?? ""),
  );
  if (!subject) {
    log("assunto vazio — nem 02-chosen-subject.txt nem opções no bloco ASSUNTO.");
    process.exitCode = 7;
    return;
  }

  const publicImages: Record<string, string> = existsSync(paths.publicImages)
    ? JSON.parse(readFileSync(paths.publicImages, "utf8"))
    : {};
  // `public-images.json` mapeia URL pública → nome do arquivo local; aqui
  // precisamos do inverso, por índice de tema (`04-d{N}-2x1.jpg`).
  const images: Record<number, string> = {};
  for (const [url, filename] of Object.entries(publicImages)) {
    const n = themeIndexFromImageFilename(String(filename));
    if (n !== null) images[n] = url;
  }

  const windowLabel = args.values["window-label"] ?? slug;
  const rendered = renderAnnualEmail(draft, { windowLabel, tipo, images });
  for (const w of rendered.warnings) log(`aviso: ${w}`);
  if (rendered.missingImages.length > 0) {
    log(`aviso: temas sem imagem pública: ${rendered.missingImages.join(", ")}`);
  }

  // #7587 item 2: relink pras edições diárias de origem — mesmo ponto em que
  // `monthly-preview-cloudflare.ts` chama `relinkMonthlyEditionHtml`, logo
  // após o render. Escopo diferente do mensal: sem Use Melhor/Radar na
  // anual, o relink vale pra TODOS os links, não só os destaques.
  let html = rendered.html;
  if (existsSync(paths.rawDestaques)) {
    try {
      const raw = JSON.parse(readFileSync(paths.rawDestaques, "utf8")) as {
        destaques?: { url?: string; edition?: string }[];
      };
      const posts = loadUnifiedEditionCache();
      const relinked = relinkAnnualEditionHtml(html, raw.destaques ?? [], posts, `anual-${slug}`);
      html = relinked.html;
      log(
        `relink: ${relinked.relinked} link(s) reescrito(s) pra edição diária, ` +
          `${relinked.naoMapeado} sem mapeamento.`,
      );
      if (relinked.ambiguous.length > 0) {
        log(
          `aviso: ${relinked.ambiguous.length} URL(s) aparecem em mais de uma edição — usada a 1ª: ` +
            relinked.ambiguous.map((a) => `${a.url} → ${a.editions.join(",")}`).join("; "),
        );
      }
    } catch (err) {
      log(`aviso: relink pulado (${(err as Error).message})`);
    }
  } else {
    log(`aviso: relink pulado — ${paths.rawDestaques} não encontrado.`);
  }
  rendered.html = html;

  if (dryRun) {
    log(`[dry-run] assunto: ${subject}`);
    log(`[dry-run] preview: ${draft.preview}`);
    log(`[dry-run] temas: ${draft.themes.length} · imagens: ${rendered.imageCount} · html: ${rendered.html.length} bytes`);
    writeFileSync(paths.previewHtml, rendered.html);
    log(`[dry-run] html gravado em ${paths.previewHtml}`);
    return;
  }

  mkdirSync(paths.internal, { recursive: true });
  writeFileSync(paths.previewHtml, rendered.html);

  const existing = readState(paths.published);
  let broadcastId: number;
  let publicUrl: string | undefined;

  if (existing) {
    log(`broadcast já existe (id=${existing.broadcast_id}) — atualizando em vez de criar um 2º.`);
    const updated = await updateBroadcast(existing.broadcast_id, {
      subject,
      preview_text: draft.preview,
      content: rendered.html,
      public: true,
    });
    broadcastId = updated.id;
    publicUrl = updated.public_url;
  } else {
    const created = await createBroadcast({
      subject,
      content: rendered.html,
      preview_text: draft.preview,
      send_at: null, // rascunho — o disparo é sempre ação humana
      subscriber_filter: buildAllSubscribersFilter(),
      public: true, // sem isso o Kit não gera public_url com slug (#6323)
    });
    broadcastId = created.id;
    publicUrl = created.public_url;
    log(`rascunho criado: broadcast_id=${broadcastId}`);
  }

  const now = new Date().toISOString();
  const state: AnnualPublishedState = {
    slug,
    broadcast_id: broadcastId,
    public_url: publicUrl,
    subject,
    status: existing?.status ?? "draft",
    test_broadcast_ids: existing?.test_broadcast_ids ?? [],
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  writeFileSync(paths.published, JSON.stringify(state, null, 2));

  if (sendTest) {
    // Broadcast SEPARADO e descartável, escopado à tag de teste — o Kit não
    // tem endpoint de test-send, e trocar o filtro do broadcast real seria
    // arriscar mandar a edição inteira pra base (mesmo desenho do #464).
    const tagId = await resolveTestSendTagId();
    const testBroadcast = await createBroadcast({
      subject: `[TESTE] ${subject}`,
      content: rendered.html,
      preview_text: draft.preview,
      send_at: new Date().toISOString(),
      subscriber_filter: buildTestSendFilter(tagId),
      public: false,
    });
    state.test_broadcast_ids = [...state.test_broadcast_ids, testBroadcast.id];
    state.status = "test_sent";
    state.updated_at = new Date().toISOString();
    writeFileSync(paths.published, JSON.stringify(state, null, 2));
    log(`test email disparado (broadcast descartável id=${testBroadcast.id}).`);
  }

  process.stdout.write(JSON.stringify(state, null, 2) + "\n");
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[publish-annual-kit] ERRO: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
