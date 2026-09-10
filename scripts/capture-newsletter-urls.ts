/**
 * capture-newsletter-urls.ts (#1520)
 *
 * Reads pre-fetched Gmail thread data (JSON), extracts URLs from newsletter
 * bodies, applies newsletter URL filtering (tracking, affiliate, sender-domain),
 * and writes SyntheticInboxArticle[] JSON directly to
 * `_internal/captured-newsletter-articles.json`.
 *
 * Eliminates the inbox.md intermediary for newsletters — URLs go straight
 * into a JSON array that inject-inbox-urls.ts merges into the article pool.
 *
 * This script does NOT call Gmail directly -- the orchestrator (Stage 0)
 * fetches threads via Gmail MCP and passes them as a JSON file.
 *
 * Usage:
 *   npx tsx scripts/capture-newsletter-urls.ts \
 *     --threads <path-to-threads.json> \
 *     --out <path-to-output.json> \
 *     --cursor data/newsletter-capture-cursor.json
 *
 * Input threads.json: array of
 *   { thread_id, sender, subject, date, body }
 *
 * Output (stdout): JSON summary
 *   { processed, skipped_already, articles_produced, urls_extracted, urls_filtered }
 *
 * Senders config: read from platform.config.json > newsletter_auto_capture.senders
 * (optional -- if absent, all threads in the input are processed).
 *
 * Refactored from auto-forward-newsletters.ts — #1514 origin, #1520 refactor.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { extractUrls, canonicalize } from "./lib/url-utils.ts";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import {
  isTrackingUrl,
  decodeTrackerUrl,
  isSenderOwnUrl,
  isAffiliateUrl,
  senderDomain,
  senderEmail,
} from "./inject-inbox-urls.ts";
import type { SyntheticInboxArticle } from "./inject-inbox-urls.ts";
// #2834: stripHtml consolidado em lib/strip-html.ts (era byte-idêntico ao
// de auto-forward-newsletters.ts). Reexportado aqui pra não quebrar imports
// existentes deste módulo (incl. test/capture-newsletter-urls.test.ts).
import { stripHtml } from "./lib/strip-html.ts";
export { stripHtml };

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapturedThread {
  thread_id: string;
  sender: string;
  subject: string;
  date: string; // ISO date string
  body: string; // plain text or HTML body
}

export interface CapturedCursor {
  processed_thread_ids: string[];
}

export interface CaptureResult {
  processed: number;
  skipped_already: number;
  articles_produced: number;
  urls_extracted: number;
  urls_filtered: number;
  /**
   * #7662: URLs de sender na allowlist (`always_consider_senders`) que TERIAM
   * sido filtradas por uma heurística de higiene (tracking/afiliado/domínio-
   * próprio) se não fossem isentas. Sem isso não dá pra saber se a isenção
   * está funcionando nem se um wrapper novo do provedor apareceu — item de
   * observabilidade pedido pela issue, não um efeito colateral do filtro.
   */
  always_consider_exemptions: Array<{ url: string; sender: string; rule: "tracking" | "affiliate" | "sender-own" }>;
  /**
   * #7662: avisos de config — sender listado em `always_consider_senders`
   * mas ausente de `senders[]` (allowlist sem efeito, porque a thread nunca
   * é buscada), ou platform.config.json ilegível. Nunca degradar em
   * silêncio: quem chama este script (stage-0-run.ts) deve propagar isto
   * pro log/relatório em vez de assumir `always_consider_senders: []`.
   */
  config_warnings: string[];
}

// ---------------------------------------------------------------------------
// Cursor helpers (exported for testing)
// ---------------------------------------------------------------------------

export function loadCursor(cursorPath: string): CapturedCursor {
  if (!existsSync(cursorPath)) return { processed_thread_ids: [] };
  try {
    const data = JSON.parse(readFileSync(cursorPath, "utf8")) as CapturedCursor;
    if (!Array.isArray(data.processed_thread_ids)) {
      return { processed_thread_ids: [] };
    }
    return data;
  } catch {
    return { processed_thread_ids: [] };
  }
}

export function saveCursor(cursorPath: string, cursor: CapturedCursor): void {
  mkdirSync(dirname(cursorPath), { recursive: true });
  const tmpPath = cursorPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(cursor, null, 2), "utf8");
  renameSync(tmpPath, cursorPath);
}

// ---------------------------------------------------------------------------
// Core processing (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Process a list of captured threads against a cursor, producing
 * SyntheticInboxArticle[] with newsletter URL filtering applied.
 *
 * Pure function -- no I/O side effects.
 */
export function processThreads(
  threads: CapturedThread[],
  cursor: CapturedCursor,
  options: { alwaysConsiderSenders?: string[]; configWarnings?: string[] } = {},
): { articles: SyntheticInboxArticle[]; result: CaptureResult; newCursor: CapturedCursor } {
  const processedSet = new Set(cursor.processed_thread_ids);
  const articles: SyntheticInboxArticle[] = [];
  const seen = new Set<string>();
  let skippedAlready = 0;
  let totalUrls = 0;
  let totalFiltered = 0;
  const alwaysConsiderSet = new Set((options.alwaysConsiderSenders ?? []).map((s) => s.toLowerCase()));
  const exemptions: CaptureResult["always_consider_exemptions"] = [];

  for (const thread of threads) {
    if (processedSet.has(thread.thread_id)) {
      skippedAlready++;
      continue;
    }

    // Extract text from body (handle HTML)
    const isHtml = /<[a-z][\s\S]*>/i.test(thread.body);
    const plainText = isHtml ? stripHtml(thread.body) : thread.body;
    const urls = extractUrls(plainText);
    totalUrls += urls.length;

    // Derive sender metadata for filtering
    const senderDom = senderDomain(thread.sender);
    const senderLabel = (thread.sender.match(/^([^<]+?)\s*</)?.[1] ?? senderDom).trim() || "newsletter";
    const senderBrand = senderLabel.replace(/[^a-z0-9]/gi, "").toLowerCase();
    // #7662: sender na allowlist "always_consider_senders" — isenta das
    // heurísticas de higiene de URL (tracking/afiliado/domínio-próprio) e,
    // via campo always_consider no artigo, das isenções downstream (janela
    // de data em filter-date-window.ts, piso de score em finalize-stage1.ts).
    // Nunca isenta dedup, acessibilidade ou regras editoriais de seção.
    const isAlwaysConsider = alwaysConsiderSet.has(senderEmail(thread.sender));

    for (const rawUrl of urls) {
      // Decode tracker URLs before filtering — sempre, mesmo em always_consider
      // (queremos a URL final, não o wrapper — issue #7662 é explícita nisso).
      const { url, decoded: trackerDecoded } = decodeTrackerUrl(rawUrl);

      const isTracking = !trackerDecoded && isTrackingUrl(rawUrl);
      const isAffiliate = isAffiliateUrl(url);
      const isSenderOwn = isSenderOwnUrl(url, senderDom, senderBrand);

      if (!isAlwaysConsider) {
        // Apply filters: tracking, affiliate, sender-own
        if (isTracking) {
          totalFiltered++;
          continue;
        }
        if (isAffiliate) {
          totalFiltered++;
          continue;
        }
        if (isSenderOwn) {
          totalFiltered++;
          continue;
        }
      } else {
        // #7662 observabilidade: registrar o que TERIA sido filtrado, pra
        // saber se a isenção está de fato valendo e detectar wrapper novo.
        // #7871 review (P3, capture-newsletter-urls.ts:191): as 3 checagens
        // acima não são mutuamente exclusivas — uma URL de tracking que
        // também aponta pro domínio do próprio sender casava 2 regras ao
        // mesmo tempo e entrava 2x em always_consider_exemptions, inflando a
        // contagem sem indicar que era a mesma URL. 1 entrada por URL,
        // prioridade tracking > affiliate > sender-own (mesma ordem em que
        // as heurísticas já são checadas acima).
        const matchedRule: "tracking" | "affiliate" | "sender-own" | undefined = isTracking
          ? "tracking"
          : isAffiliate
            ? "affiliate"
            : isSenderOwn
              ? "sender-own"
              : undefined;
        if (matchedRule) {
          exemptions.push({ url: matchedRule === "tracking" ? rawUrl : url, sender: thread.sender, rule: matchedRule });
        }
      }

      // Dedup by canonical URL — correção, nunca isenta (#7662)
      const key = canonicalize(url).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      articles.push({
        url,
        source: `inbox_newsletter:${senderLabel}`,
        title: `(newsletter:${senderLabel})`,
        flag: "newsletter_extracted",
        submitted_at: thread.date,
        submitted_subject: thread.subject,
        submitted_via: `newsletter:${senderLabel}`,
        tracker_decoded: trackerDecoded || undefined,
        always_consider: isAlwaysConsider || undefined,
      });
    }

    processedSet.add(thread.thread_id);
  }

  if (exemptions.length > 0) {
    for (const e of exemptions) {
      console.error(`[capture-newsletter-urls] #7662 always_consider isentou "${e.url}" (sender ${e.sender}) da heurística "${e.rule}"`);
    }
  }

  return {
    articles,
    result: {
      processed: threads.length,
      skipped_already: skippedAlready,
      articles_produced: articles.length,
      urls_extracted: totalUrls,
      urls_filtered: totalFiltered,
      always_consider_exemptions: exemptions,
      config_warnings: options.configWarnings ?? [],
    },
    newCursor: {
      processed_thread_ids: [...processedSet],
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  threadsPath: string;
  outPath: string;
  cursorPath: string;
} {
  // #2834: argv aqui é process.argv completo (loop legado começava em i=2
  // pra pular node/script path) — parseArgsSimple espera argv já sem esses
  // 2 primeiros elementos, daí o slice(2). Consumo incondicional do próximo
  // token (mesmo que comece com "--") é o mesmo comportamento do switch-case
  // anterior (`argv[++i]`), preservado por parseArgsSimple.
  const values = parseArgsSimple(argv.slice(2));
  const threadsPath = values["threads"] ?? "";
  const outPath = values["out"] ?? "";
  const cursorPath = values["cursor"] ?? resolve(ROOT, "data", "newsletter-capture-cursor.json");

  if (!threadsPath || !outPath) {
    console.error("Usage: npx tsx scripts/capture-newsletter-urls.ts --threads <path> --out <path>");
    process.exit(1);
  }

  return { threadsPath, outPath, cursorPath };
}

/**
 * #7662: lê `newsletter_auto_capture.always_consider_senders` de
 * platform.config.json. Validação explícita, nunca degrada em silêncio:
 * config ilegível ou sender ausente de `senders[]` (allowlist sem efeito,
 * pois a thread nunca é buscada) viram `configWarnings` — o CLI imprime cada
 * um via stderr e os propaga no summary JSON pra quem chama (stage-0-run.ts)
 * não assumir "allowlist vazia" sem saber por quê.
 */
export function loadAlwaysConsiderConfig(configPath: string): { alwaysConsiderSenders: string[]; configWarnings: string[] } {
  const configWarnings: string[] = [];
  let alwaysConsiderSenders: string[] = [];
  if (!existsSync(configPath)) {
    configWarnings.push(`platform.config.json não encontrado em ${configPath} — always_consider_senders não pôde ser carregado.`);
    return { alwaysConsiderSenders, configWarnings };
  }
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      newsletter_auto_capture?: { senders?: unknown; always_consider_senders?: unknown };
    };
    const nac = cfg.newsletter_auto_capture ?? {};
    const senders = Array.isArray(nac.senders) ? (nac.senders as unknown[]).map(String) : [];
    const always = Array.isArray(nac.always_consider_senders) ? (nac.always_consider_senders as unknown[]).map(String) : [];
    const sendersLower = new Set(senders.map((s) => s.toLowerCase()));
    for (const s of always) {
      if (!sendersLower.has(s.toLowerCase())) {
        configWarnings.push(
          `always_consider_senders inclui "${s}" que não está em newsletter_auto_capture.senders[] — a allowlist não tem efeito nenhum pra esse sender, porque as threads dele nunca são buscadas.`,
        );
      }
    }
    alwaysConsiderSenders = always;
  } catch (err) {
    configWarnings.push(`platform.config.json ilegível — always_consider_senders não pôde ser carregado: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { alwaysConsiderSenders, configWarnings };
}

export function main(argv: string[] = process.argv): void {
  const { threadsPath, outPath, cursorPath } = parseArgs(argv);
  const { alwaysConsiderSenders, configWarnings } = loadAlwaysConsiderConfig(resolve(ROOT, "platform.config.json"));
  for (const w of configWarnings) console.error(`[capture-newsletter-urls] WARN ${w}`);

  // Read threads
  if (!existsSync(threadsPath)) {
    console.error(`Threads file not found: ${threadsPath}`);
    process.exit(1);
  }

  let threads: CapturedThread[];
  try {
    const raw = JSON.parse(readFileSync(threadsPath, "utf8"));
    if (!Array.isArray(raw)) {
      console.error("Threads file must contain a JSON array");
      process.exit(1);
    }
    threads = raw as CapturedThread[];
  } catch (err) {
    console.error(`Failed to parse threads file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Empty array = no-op (preserve existing output if any)
  if (threads.length === 0) {
    const result: CaptureResult = {
      processed: 0,
      skipped_already: 0,
      articles_produced: 0,
      urls_extracted: 0,
      urls_filtered: 0,
      always_consider_exemptions: [],
      config_warnings: configWarnings,
    };
    const absOut = resolve(ROOT, outPath);
    if (!existsSync(absOut)) {
      mkdirSync(dirname(absOut), { recursive: true });
      const tmpOut = absOut + ".tmp";
      writeFileSync(tmpOut, JSON.stringify([], null, 2) + "\n", "utf8");
      renameSync(tmpOut, absOut);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Load cursor
  const cursor = loadCursor(cursorPath);

  // Process
  const { articles, result, newCursor } = processThreads(threads, cursor, { alwaysConsiderSenders, configWarnings });

  // Merge with existing output (crash-resume safety: re-run preserves prior articles)
  const absOut = resolve(ROOT, outPath);
  mkdirSync(dirname(absOut), { recursive: true });
  let existing: SyntheticInboxArticle[] = [];
  if (existsSync(absOut)) {
    try {
      existing = JSON.parse(readFileSync(absOut, "utf8"));
    } catch { /* corrupt file — overwrite */ }
  }
  const existingUrls = new Set(existing.map((a) => a.url));
  const merged = [...existing, ...articles.filter((a) => !existingUrls.has(a.url))];
  const tmpOut = absOut + ".tmp";
  writeFileSync(tmpOut, JSON.stringify(merged, null, 2) + "\n", "utf8");
  renameSync(tmpOut, absOut);

  // Save cursor
  saveCursor(cursorPath, newCursor);

  // Print summary
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main();
}
