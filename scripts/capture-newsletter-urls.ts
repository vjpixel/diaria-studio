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
 *     --cursor data/newsletter-capture-cursor.json \
 *     [--edition AAMMDD]   # default: derivada do --out (#9368)
 *
 * Cursor (#9368): por edição, não global — `threads[thread_id].editions`
 * registra em quais edições a thread foi extraída. Re-run da mesma edição
 * re-extrai (idempotente via merge); thread é reoferecida em até
 * MAX_OFFER_EDITIONS edições; o cursor só avança depois que a saída é
 * gravada e relida numa edição real.
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
  isNonContentUrl,
  senderDomain,
  senderEmail,
} from "./inject-inbox-urls.ts";
import type { SyntheticInboxArticle } from "./inject-inbox-urls.ts";
import { unionNewsletterMentions } from "./lib/newsletter-mention-bonus.ts"; // #9365
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
  body: string; // plain text or HTML body (pode vir truncado em BODY_LIMIT)
  // #8668/#8710: URLs do corpo COMPLETO, extraídas antes do truncamento por
  // fetch-newsletter-threads.ts. Unidas às do body abaixo.
  urls_extraidas?: string[];
}

/**
 * #9368: registro por thread — em qual(is) edição(ões) a thread foi extraída
 * e quantos artigos ela deixou. Auditoria (`thread_id → edição`) e base da
 * regra de reoferta (`isThreadEligible`).
 */
export interface CursorThreadEntry {
  /** Edições (AAMMDD) em que os artigos desta thread foram gravados, em ordem. */
  editions: string[];
  /** Nº de artigos que a thread produziu na extração mais recente. */
  articles: number;
}

export interface CapturedCursor {
  /**
   * Lista legada (pré-#9368) — ids consumidos pelo regime de cursor global.
   * Continua sendo escrita (superset) pra compat com leitores antigos
   * (`auto-forward-newsletters.ts`). Id presente SÓ aqui, sem entrada em
   * `threads`, é tratado como consumido (não há registro de edição pra
   * reofertar).
   */
  processed_thread_ids: string[];
  /** #9368: `thread_id → { editions, articles }`. */
  threads?: Record<string, CursorThreadEntry>;
}

/**
 * #9368: nº máximo de edições em que uma mesma thread é oferecida — a
 * original + 2 reofertas. Item extraído e não entregue volta ao pool das
 * ~2 edições seguintes (enquanto a thread ainda estiver na janela de busca
 * do 0b-bis); o que já foi publicado sai no dedup do Stage 1 contra
 * `past-editions.md`, não aqui.
 */
export const MAX_OFFER_EDITIONS = 3;

/**
 * #9368: decide se a thread deve ser extraída para `edition`.
 *
 * - sem `edition` (uso ad-hoc / legado): só threads nunca vistas — mesmo
 *   comportamento do cursor global antigo;
 * - thread já registrada PARA ESTA edição: sim (re-run da mesma edição é
 *   idempotente — o bug do 260921 foi justamente um 2º run da edição achar
 *   as 11 threads "já processadas" e gravar `[]`);
 * - thread registrada em menos de `MAX_OFFER_EDITIONS` edições: sim (reoferta);
 * - id só na lista legada, sem registro de edição: não.
 */
export function isThreadEligible(cursor: CapturedCursor, threadId: string, edition?: string): boolean {
  const entry = cursor.threads?.[threadId];
  if (entry) {
    if (!edition) return false;
    if (entry.editions.includes(edition)) return true;
    return entry.editions.length < MAX_OFFER_EDITIONS;
  }
  return !cursor.processed_thread_ids.includes(threadId);
}

/**
 * #9368: deriva a edição (AAMMDD) do path de saída
 * (`data/editions/{AAMM}/{AAMMDD}/_internal/...` ou layout flat legado).
 * Retorna undefined fora de uma edição real (uso ad-hoc, testes).
 */
export function editionFromOutPath(outPath: string): string | undefined {
  return outPath.match(/(?:^|[\\/])(\d{6})[\\/]_internal[\\/]/)?.[1];
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
    if (data.threads !== undefined && (typeof data.threads !== "object" || data.threads === null || Array.isArray(data.threads))) {
      // Shape inesperado no mapa novo: descarta só o mapa (ids legados seguem
      // valendo). Pior caso é reofertar menos, nunca perder a lista legada.
      delete data.threads;
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
  options: { alwaysConsiderSenders?: string[]; configWarnings?: string[]; edition?: string } = {},
): { articles: SyntheticInboxArticle[]; result: CaptureResult; newCursor: CapturedCursor } {
  const processedSet = new Set(cursor.processed_thread_ids);
  const threadsMap: Record<string, CursorThreadEntry> = { ...(cursor.threads ?? {}) };
  const edition = options.edition;
  const articles: SyntheticInboxArticle[] = [];
  // #9365: chave canônica → artigo já emitido, pra somar a menção de outra
  // newsletter que cita a MESMA URL (bônus de score por newsletter distinta).
  const seen = new Map<string, SyntheticInboxArticle>();
  let skippedAlready = 0;
  let totalUrls = 0;
  let totalFiltered = 0;
  const alwaysConsiderSet = new Set((options.alwaysConsiderSenders ?? []).map((s) => s.toLowerCase()));
  const exemptions: CaptureResult["always_consider_exemptions"] = [];

  for (const thread of threads) {
    if (!isThreadEligible(cursor, thread.thread_id, edition)) {
      skippedAlready++;
      continue;
    }
    const articlesBefore = articles.length;

    // Extract text from body (handle HTML)
    const isHtml = /<[a-z][\s\S]*>/i.test(thread.body);
    const plainText = isHtml ? stripHtml(thread.body) : thread.body;
    // #8710: o body chega truncado — links do fim de newsletters longas só
    // existem em urls_extraidas. União com dedup, ordem do body primeiro.
    const urls = [...new Set([...extractUrls(plainText), ...(thread.urls_extraidas ?? [])])];
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
    // #9365: identidade da newsletter pro bônus de menção — e-mail do
    // remetente (2 edições da mesma newsletter contam 1); domínio como fallback.
    const mentionId = senderEmail(thread.sender) || senderDom;

    for (const rawUrl of urls) {
      // Decode tracker URLs before filtering — sempre, mesmo em always_consider
      // (queremos a URL final, não o wrapper — issue #7662 é explícita nisso).
      const { url, decoded: trackerDecoded } = decodeTrackerUrl(rawUrl);

      // #9250: unsubscribe/preferências nunca é conteúdo — filtrado ANTES
      // da isenção always_consider (que cobre só as heurísticas abaixo).
      if (isNonContentUrl(url) || isNonContentUrl(rawUrl)) {
        totalFiltered++;
        continue;
      }
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
      const already = seen.get(key);
      if (already) {
        already.newsletter_mentions = unionNewsletterMentions(already.newsletter_mentions, mentionId ? [mentionId] : []);
        continue;
      }

      const article: SyntheticInboxArticle = {
        url: canonicalize(url),
        source: `inbox_newsletter:${senderLabel}`,
        title: `(newsletter:${senderLabel})`,
        flag: "newsletter_extracted",
        submitted_at: thread.date,
        submitted_subject: thread.subject,
        submitted_via: `newsletter:${senderLabel}`,
        tracker_decoded: trackerDecoded || undefined,
        always_consider: isAlwaysConsider || undefined,
        newsletter_mentions: mentionId ? [mentionId] : undefined,
      };
      seen.set(key, article);
      articles.push(article);
    }

    processedSet.add(thread.thread_id);
    if (edition) {
      const prev = threadsMap[thread.thread_id];
      const editions = prev ? [...prev.editions] : [];
      if (!editions.includes(edition)) editions.push(edition);
      threadsMap[thread.thread_id] = { editions, articles: articles.length - articlesBefore };
    }
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
      ...(Object.keys(threadsMap).length > 0 ? { threads: threadsMap } : {}),
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
  edition: string | undefined;
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
  // #9368: edição explícita (--edition AAMMDD) ou derivada do --out.
  const editionArg = values["edition"];
  if (editionArg !== undefined && !/^\d{6}$/.test(editionArg)) {
    console.error(`--edition inválido: "${editionArg}" (esperado AAMMDD)`);
    process.exit(1);
  }
  const edition = editionArg ?? editionFromOutPath(outPath);

  if (!threadsPath || !outPath) {
    console.error("Usage: npx tsx scripts/capture-newsletter-urls.ts --threads <path> --out <path> [--edition AAMMDD] [--cursor <path>]");
    process.exit(1);
  }

  return { threadsPath, outPath, cursorPath, edition };
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

/**
 * Merge da saída existente (re-run / crash-resume) com os artigos recém-
 * extraídos: URL nova é acrescentada; URL já presente fica como estava, mas
 * #9365 une as `newsletter_mentions` — senão a 2ª newsletter citando a mesma
 * URL num re-run da edição não contaria pro bônus de score. Pura.
 */
export function mergeCapturedArticles(
  existing: SyntheticInboxArticle[],
  fresh: SyntheticInboxArticle[],
): SyntheticInboxArticle[] {
  const merged = existing.map((a) => ({ ...a }));
  const byUrl = new Map(merged.map((a) => [a.url, a]));
  for (const a of fresh) {
    const prev = byUrl.get(a.url);
    if (!prev) {
      merged.push(a);
      byUrl.set(a.url, a);
      continue;
    }
    const mentions = unionNewsletterMentions(prev.newsletter_mentions, a.newsletter_mentions);
    if (mentions.length > 0) prev.newsletter_mentions = mentions;
  }
  return merged;
}

/**
 * #9368: relê a saída recém-gravada e confere a contagem antes de o cursor
 * avançar. Pura sobre o filesystem (exportada pra teste).
 */
export function verifyPersistedOutput(absOut: string, expectedCount: number): { ok: true } | { ok: false; reason: string } {
  try {
    const back = JSON.parse(readFileSync(absOut, "utf8"));
    if (!Array.isArray(back)) return { ok: false, reason: "não é array" };
    if (back.length !== expectedCount) return { ok: false, reason: `esperado ${expectedCount} artigo(s), relido ${back.length}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function main(argv: string[] = process.argv): void {
  const { threadsPath, outPath, cursorPath, edition } = parseArgs(argv);
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
  const { articles, result, newCursor } = processThreads(threads, cursor, { alwaysConsiderSenders, configWarnings, edition });

  // Merge with existing output (crash-resume safety: re-run preserves prior articles)
  const absOut = resolve(ROOT, outPath);
  mkdirSync(dirname(absOut), { recursive: true });
  let existing: SyntheticInboxArticle[] = [];
  if (existsSync(absOut)) {
    try {
      existing = JSON.parse(readFileSync(absOut, "utf8"));
    } catch { /* corrupt file — overwrite */ }
  }
  const merged = mergeCapturedArticles(existing, articles);
  const tmpOut = absOut + ".tmp";
  writeFileSync(tmpOut, JSON.stringify(merged, null, 2) + "\n", "utf8");
  renameSync(tmpOut, absOut);

  // #9368: o cursor só avança DEPOIS que a saída foi gravada e relida de uma
  // edição real. Antes, o cursor global marcava a thread como consumida
  // independentemente de a saída chegar a alguma edição — em 260921, 11
  // threads ficaram marcadas e o captured-newsletter-articles.json da edição
  // ficou `[]` (o extrator, rodado depois sobre as mesmas threads, dá 113
  // URLs). Execução fora de edição (--out ad-hoc, sem --edition) nunca
  // consome o cursor.
  const persisted = verifyPersistedOutput(absOut, merged.length);
  if (!persisted.ok) {
    console.error(`[capture-newsletter-urls] ERRO: saída não confirmada em ${absOut} (${persisted.reason}) — cursor NÃO avançado.`);
    process.exit(1);
  }
  if (edition) {
    saveCursor(cursorPath, newCursor);
  } else {
    console.error("[capture-newsletter-urls] sem edição (--edition ausente e --out fora de data/editions/{AAMMDD}/_internal/) — cursor NÃO avançado (#9368).");
  }

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
