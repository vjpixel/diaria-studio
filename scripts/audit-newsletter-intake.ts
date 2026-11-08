/** #12188: deterministic intake ledger, complete link scores and gate report.
 * --edition AAMMDD [--edition-dir path] [--require-scores]
 * --sender email --from AAMMDD --to AAMMDD: read-only ledger query.
 * --decisions batch.json [--edition AAMMDD]: persist explicit editor decisions
 *   in the versioned registry. Rejections only persist for senders the gate
 *   offered (`pending_senders` of that edition's report) — never for an
 *   address the discovery kept out of the offer (item 6, privacy).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { processThreads, type CapturedThread } from "./capture-newsletter-urls.ts";
import type { DiscoveredThread, FetchManifestEvent } from "./fetch-newsletter-threads.ts";
import { canonicalize } from "./lib/url-utils.ts";
import {
  classifySender, detectBulkService, loadSenderRegistry, senderKey, validateSenderDecision, validateSenderRegistry,
  DEFAULT_BULK_SERVICE_DOMAINS, type SenderRegistry, type SenderDecision,
} from "./lib/newsletter-senders.ts";
import { computeIntakeFingerprint, reviewedEntries } from "./lib/newsletter-intake-fingerprint.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

export interface IntakeThread extends CapturedThread { capture_error?: string }
type Item = Record<string, unknown>;
export interface LinkAudit {
  url: string; title: string; score: number | null; score_status: "pontuado" | "pendente";
  thread_id: string; newsletter: string; destino: string;
}
export interface IntakeOptions {
  /** Threads da descoberta (`discovered-newsletters.json`) — só auditoria. */
  discovered?: DiscoveredThread[];
  bulkDomains?: string[];
  /** Threads que falharam na captura por remetente e não chegaram ao arquivo. */
  failedThreads?: Array<{ thread_id: string; error?: string }>;
}
export function urlKey(url: string): string { return canonicalize(url).toLowerCase(); }
/** Accept pool, chunk, fallback and approved shapes without selecting only finalists. */
export function collectItems(value: unknown): Item[] {
  if (Array.isArray(value)) return value.flatMap(collectItems);
  if (!value || typeof value !== "object") return [];
  const obj = value as Item;
  const article = obj.article && typeof obj.article === "object" ? obj.article as Item : undefined;
  const normalized = article && typeof article.url === "string" ? {...article, ...obj, url: article.url} : obj;
  return [...(typeof normalized.url === "string" ? [normalized] : []), ...Object.entries(obj).filter(([key]) => key !== "article").flatMap(([, child]) => collectItems(child))];
}
/** Keys of `01-approved.json` that are NOT in the edition (fallback without 02-reviewed.md). */
const NOT_IN_EDITION_KEYS = new Set(["runners_up", "all_scored", "coverage", "rejected", "dropped"]);
const DESTAQUE = "destaque";

export function buildIntake(threads: IntakeThread[], registry: SenderRegistry, scores: unknown[], pool: unknown, final: unknown,
  alwaysConsiderSenders: string[] = [], metadata: unknown[] = [], opts: IntakeOptions = {}) {
  const scored = new Map<string, Item>();
  for (const item of scores.flatMap(collectItems)) {
    if (typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < 0 || item.score > 100) continue;
    for (const alias of [item.url, item.resolvedFrom, item.original_url]) {
      if (typeof alias === "string") scored.set(urlKey(alias), item);
    }
  }
  // Join redirects resolved by enrichment back to the captured URL.
  const metadataItems = [...metadata, pool, final].flatMap(collectItems);
  for (let pass = 0; pass < 3; pass++) for (const item of metadataItems) {
    const aliases = [item.url, item.resolvedFrom, item.original_url].filter((u): u is string => typeof u === "string").map(urlKey);
    const match = aliases.map((k) => scored.get(k)).find(Boolean);
    if (match) for (const key of aliases) scored.set(key, match);
  }
  const titles = new Map<string, string>();
  for (const item of [...scores, ...metadata, pool, final].flatMap(collectItems)) {
    if (typeof item.title === "string" && !item.title.startsWith("(newsletter:")) {
      for (const alias of [item.url, item.resolvedFrom, item.original_url]) if (typeof alias === "string") titles.set(urlKey(alias), item.title);
    }
  }
  const poolKeys = new Set(collectItems(pool).flatMap((i) => [i.url, i.resolvedFrom, i.original_url])
    .filter((u): u is string => typeof u === "string").map(urlKey));
  const destinations = new Map<string, string>();
  // #12188 item 8: "destaque" wins over any section that also lists the URL.
  const setDestination = (key: string, destination: string) => {
    if (destinations.get(key) !== DESTAQUE) destinations.set(key, destination);
  };
  function visit(value: unknown, section = "seção") {
    if (Array.isArray(value)) { value.forEach((v) => visit(v, section)); return; }
    if (!value || typeof value !== "object") return;
    const item = value as Item;
    if (typeof item.url === "string") setDestination(urlKey(item.url), typeof item.destination === "string" ? item.destination : section);
    for (const [key, child] of Object.entries(item)) {
      if (NOT_IN_EDITION_KEYS.has(key)) continue;
      visit(child, /^(highlights|destaques)$/.test(key) ? DESTAQUE : ["radar", "lancamento", "use_melhor", "video"].includes(key) ? key : section);
    }
  }
  visit(final);
  const links: LinkAudit[] = [];
  const poolKnown = pool !== undefined;
  const rows = threads.map((thread) => {
    const classification = classifySender(thread.sender, registry);
    const extraction = processThreads([thread], {processed_thread_ids: []}, {alwaysConsiderSenders});
    const articles = extraction.articles;
    if (classification.classificacao === "IA") for (const article of articles) {
      const key = urlKey(article.url);
      const match = scored.get(key);
      const destination = destinations.get(key) ?? (typeof match?.url === "string" ? destinations.get(urlKey(match.url)) : undefined);
      links.push({url: article.url, title: titles.get(key) ?? (typeof match?.title === "string" ? match.title : article.title),
        score: typeof match?.score === "number" ? match.score : null, score_status: match ? "pontuado" : "pendente",
        thread_id: thread.thread_id, newsletter: thread.sender, destino: destination ?? "fora da edição"});
    }
    const threadLinks = links.filter((l) => l.thread_id === thread.thread_id);
    const pending = threadLinks.filter((l) => l.score === null).length;
    const untitled = threadLinks.filter((l) => !l.title.trim() || l.title.startsWith("(newsletter:")).length;
    const inPool = articles.filter((a) => poolKeys.has(urlKey(a.url))).length;
    const ia = classification.classificacao === "IA";
    // #12188 item 3: approved newsletter with 0 links is a failure, never "lida".
    const [estado, estado_motivo] =
      thread.capture_error ? ["falhou", thread.capture_error]
      : !ia ? ["ignorada", classification.classificacao_motivo]
      : articles.length === 0 ? ["falhou", `Newsletter aprovada sem nenhum link capturado (${extraction.result.urls_extracted} extraídos, ${extraction.result.urls_filtered} filtrados)`]
      : pending || untitled ? ["falhou", `${pending} links aguardam pontuação; ${untitled} aguardam título`]
      : poolKnown && inPool < articles.length ? ["parcial", `${articles.length - inPool} de ${articles.length} links capturados não chegaram ao pool (dedup/filtro)`]
      : ["lida", "Links extraídos e pontuados; sem resumo"];
    return {thread_id: thread.thread_id, remetente: thread.sender, assunto: thread.subject, data: thread.date,
      ...classification, links_extraidos: extraction.result.urls_extracted,
      links_capturados: articles.length, links_no_pool: inPool,
      links_pontuados: ia ? articles.length - pending : 0,
      estado, estado_motivo,
    };
  });
  const capturedIds = new Set(threads.map((t) => t.thread_id));
  // Threads that failed in the sender-group capture never enter captured-newsletters.json
  // (a placeholder would count as a newsletter in the coverage line); the intake keeps them.
  const seenFailed = new Set<string>();
  for (const failed of opts.failedThreads ?? []) {
    if (capturedIds.has(failed.thread_id) || seenFailed.has(failed.thread_id)) continue;
    seenFailed.add(failed.thread_id);
    rows.push({thread_id: failed.thread_id, remetente: "", assunto: "", data: "", classificacao: "incerta", remetente_status: "novo-pendente",
      classificacao_motivo: "Thread da busca por remetente aprovado sem metadados legíveis", links_extraidos: 0, links_capturados: 0,
      links_no_pool: 0, links_pontuados: 0, estado: "falhou", estado_motivo: failed.error ?? "Falha na captura"});
  }
  links.sort((a,b) => (b.score ?? -1) - (a.score ?? -1) || a.url.localeCompare(b.url) || a.thread_id.localeCompare(b.thread_id));
  const pendingSenders = new Set(rows.filter((r) => r.remetente_status === "novo-pendente" && r.remetente).map((r) => senderKey(r.remetente)));
  // #12188 items 1 and 6: discovery only offers bulk-service senders; the rest is a count.
  const discovery = {threads: 0, oferecidos: [] as Array<{thread_id: string; remetente: string; assunto: string; data: string; servico: string}>,
    fora_de_servico_conhecido: 0, rejeitados: 0, aprovados_fora_da_captura: 0};
  for (const thread of opts.discovered ?? []) {
    if (capturedIds.has(thread.thread_id)) continue;
    discovery.threads++;
    const status = classifySender(thread.sender, registry).remetente_status;
    if (status === "rejeitado") { discovery.rejeitados++; continue; }
    if (status === "aprovado") { discovery.aprovados_fora_da_captura++; continue; }
    const service = detectBulkService([thread.list_id, thread.list_unsubscribe, thread.return_path, thread.sender], opts.bulkDomains);
    if (!service) { discovery.fora_de_servico_conhecido++; continue; }
    pendingSenders.add(senderKey(thread.sender));
    discovery.oferecidos.push({thread_id: thread.thread_id, remetente: thread.sender, assunto: thread.subject, data: thread.date, servico: service});
  }
  return {rows, links, pending_senders: [...pendingSenders].sort(), discovery};
}
function json(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function optional(path: string): unknown { return existsSync(path) ? json(path) : undefined; }
function cache(path: string): unknown {
  try { return optional(path); } catch (error) {
    console.error(`[audit-newsletter-intake] WARN cache ilegível ignorado (${basename(path)}): ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
export function appendSnapshots(path: string, edition: string, rows: unknown[]): number {
  mkdirSync(dirname(path), {recursive: true});
  const previous = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const hashes = new Map(previous.map((r) => [r.thread_id, r.snapshot_hash]));
  let added = 0;
  for (const row of rows) {
    const hash = createHash("sha256").update(JSON.stringify(row)).digest("hex");
    const id = (row as {thread_id: string}).thread_id;
    if (hashes.get(id) === hash) continue;
    appendFileSync(path, JSON.stringify({edition, at: new Date().toISOString(), snapshot_hash: hash, ...row as object}) + "\n");
    hashes.set(id, hash); added++;
  }
  return added;
}
/**
 * Validates the whole batch BEFORE writing; the registry file is only replaced
 * by an atomic rename of an already-validated document. `offered` = senders the
 * gate offered: rejections outside it are skipped (never written to the seed).
 */
export function applyDecisions(path: string, batch: Record<string, SenderDecision>, offered?: Set<string>): {applied: number; skipped_rejections: number} {
  const registry = loadSenderRegistry(path);
  if (!batch || typeof batch !== "object" || Array.isArray(batch) || !Object.keys(batch).length) throw new Error("Lote de decisões vazio/inválido");
  const next: SenderRegistry = {version: 1, senders: {...registry.senders}};
  let applied = 0; let skipped = 0;
  for (const [sender, decision] of Object.entries(batch)) {
    const key = senderKey(sender);
    validateSenderDecision(key, decision);
    if (decision.status === "rejeitado" && !offered?.has(key)) { skipped++; continue; }
    next.senders[key] = decision; applied++;
  }
  validateSenderRegistry(next);
  const tmp = path + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, {force: true});
    throw new Error(`Falha ao gravar o registro; registro preservado: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {applied, skipped_rejections: skipped};
}
/** Latest event per scope (#12188 item 9): the manifest is append-only. */
export function latestManifestEvents(manifestPath: string): FetchManifestEvent[] {
  if (!existsSync(manifestPath)) return [];
  const events = readFileSync(manifestPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as FetchManifestEvent);
  return [...new Map(events.map((e) => [e.scope ?? e.query ?? "", e])).values()];
}
export function main(argv = process.argv.slice(2)): void {
  const {values, flags} = parseArgs(argv);
  const dataDir = resolve(values["data-dir"] ?? "data");
  const registryPath = resolve(values.registry ?? "seed/newsletter-senders.json");
  const editionDirOf = (edition: string) => resolve(values["edition-dir"] ?? `${dataDir}/editions/${edition}`);
  if (values.decisions) {
    let offered: Set<string> | undefined;
    if (values.edition) {
      const report = optional(resolve(editionDirOf(values.edition), "_internal/newsletter-link-scores.json")) as {pending_senders?: string[]} | undefined;
      offered = new Set((report?.pending_senders ?? []).map(senderKey));
    }
    const outcome = applyDecisions(registryPath, json(values.decisions) as Record<string, SenderDecision>, offered);
    if (outcome.skipped_rejections) console.error(`[audit-newsletter-intake] ${outcome.skipped_rejections} rejeição(ões) de remetente não oferecido no gate ficaram fora do seed (#12188, privacidade)`);
    console.log(JSON.stringify(outcome));
    return;
  }
  if (!values.edition) {
    const ledger = resolve(dataDir, "newsletter-intake");
    const entries = existsSync(ledger) ? readdirSync(ledger).filter((f) => /^\d{6}\.jsonl$/.test(f)).sort().flatMap((f) => {
      const edition = basename(f, ".jsonl");
      if (values.from && edition < values.from || values.to && edition > values.to) return [];
      return readFileSync(resolve(ledger, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }).filter((r) => !values.sender || senderKey(r.remetente) === senderKey(values.sender)) : [];
    console.log(JSON.stringify(entries, null, 2)); return;
  }
  if (!/^\d{6}$/.test(values.edition)) throw new Error("--edition deve ser AAMMDD");
  const editionDir = editionDirOf(values.edition);
  const internal = resolve(editionDir, "_internal");
  mkdirSync(internal, {recursive: true});
  const fingerprint = computeIntakeFingerprint(editionDir, registryPath);
  const capturedPath = resolve(internal, "captured-newsletters.json");
  const threads = (optional(capturedPath) ?? []) as IntakeThread[];
  if (!Array.isArray(threads)) throw new Error("captured-newsletters deve ser array");
  const discovered = (cache(resolve(internal, "discovered-newsletters.json")) ?? []) as DiscoveredThread[];
  const scores = ["tmp-allscored.json", "tmp-scored.json", "newsletter-extra-scores.json", "01-approved.json"].map((f) => optional(resolve(internal, f)));
  const pool = optional(resolve(internal, "tmp-articles-raw.json"));
  const metadata = ["tmp-dates-reviewed.json", "captured-newsletter-articles.json"].map((f) => optional(resolve(internal, f)));
  metadata.push(cache(resolve(internal, "newsletter-link-scores.json")), cache(resolve(internal, "newsletter-unscored.json")));
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const final = existsSync(reviewedPath) ? reviewedEntries(readFileSync(reviewedPath, "utf8")) : optional(resolve(internal, "01-approved.json"));
  const config = optional(resolve("platform.config.json")) as {newsletter_auto_capture?: {always_consider_senders?: string[]; bulk_service_domains?: string[]}} | undefined;
  const bulkDomains = Array.isArray(config?.newsletter_auto_capture?.bulk_service_domains) ? config.newsletter_auto_capture.bulk_service_domains : DEFAULT_BULK_SERVICE_DOMAINS;
  const captureEvents = latestManifestEvents(resolve(internal, "captured-newsletters.json.fetch.jsonl"));
  const failedThreads = captureEvents.flatMap((e) => (e.outcomes ?? []).filter((o) => o.outcome === "falhou").map((o) => ({thread_id: o.thread_id, error: o.error})));
  const result = buildIntake(threads, loadSenderRegistry(registryPath), scores, pool, final, config?.newsletter_auto_capture?.always_consider_senders, metadata,
    {discovered: Array.isArray(discovered) ? discovered : [], bulkDomains, failedThreads});
  const ledger = resolve(dataDir, `newsletter-intake/${values.edition}.jsonl`);
  appendSnapshots(ledger, values.edition, result.rows);
  const warnings: string[] = [];
  if (!existsSync(capturedPath)) warnings.push("Captura indisponível: captured-newsletters.json ausente");
  if (captureEvents.length) {
    for (const event of captureEvents) if (event.failed) warnings.push(`capture_failed: ${event.error}`);
    const ids = new Set(captureEvents.flatMap((e) => e.thread_ids ?? []));
    const recorded = new Set(result.rows.map((r) => r.thread_id));
    if (ids.size !== recorded.size || [...ids].some((id) => !recorded.has(id))) warnings.push(`total no inbox na janela (${ids.size}) != total registrado (${recorded.size})`);
  } else warnings.push("Total no inbox na janela indisponível: manifesto da captura ausente");
  for (const event of latestManifestEvents(resolve(internal, "discovered-newsletters.json.fetch.jsonl"))) {
    if (event.failed) warnings.push(`Descoberta de remetentes novos falhou: ${event.error}`);
  }
  if (result.discovery.aprovados_fora_da_captura) warnings.push(`${result.discovery.aprovados_fora_da_captura} thread(s) de remetente aprovado achada(s) só pela descoberta — re-rodar a captura por remetente`);
  if (existsSync(resolve(internal, ".capture-newsletter-failed.json"))) warnings.push("capture_failed: captura Gmail falhou");
  if (result.rows.some((r) => r.estado === "falhou")) warnings.push("Há newsletters com estado falhou; conferir motivos no intake");
  if (result.rows.some((r) => r.estado === "parcial")) warnings.push("Há newsletters com links que não chegaram ao pool; conferir motivos no intake");
  const missing = [...new Map(result.links.filter((l) => l.score === null || !l.title.trim() || l.title.startsWith("(newsletter:")).map((l) => [urlKey(l.url), l])).values()];
  // Same input contract as scorer-chunk. Supplemental scores never change selection.
  const metadataItems = [...metadata, pool].flatMap(collectItems);
  const supplemental = missing.map((link) => ({...metadataItems.find((i) => typeof i.url === "string" && urlKey(i.url) === urlKey(link.url)), ...link, flag: "newsletter_extracted"}));
  writeFileSync(resolve(internal, "newsletter-unscored.json"), JSON.stringify({articles: supplemental, categorized: {radar: supplemental, lancamento: [], use_melhor: [], video: []}}, null, 2) + "\n");
  writeFileSync(resolve(internal, "newsletter-link-scores.json"), JSON.stringify({...result, warnings, input_fingerprint: fingerprint, registry_path: registryPath}, null, 2) + "\n");
  const cell = (value: unknown) => String(value).replace(/[\r\n|]/g, " ");
  const report = ["## Intake de newsletters de IA", ...warnings.map((w) => `⚠️ ${w}`),
    `Remetentes novos pendentes (decidir em um lote): ${result.pending_senders.join(", ") || "nenhum"}`,
    `Descoberta: ${result.discovery.threads} thread(s) fora da captura; ${result.discovery.oferecidos.length} de serviço de envio conhecido (oferecidas acima), ${result.discovery.fora_de_servico_conhecido} sem serviço conhecido (só contagem), ${result.discovery.rejeitados} de remetente rejeitado`,
    "", "| Score | Título | Newsletter | Destino | URL |", "| --- | --- | --- | --- | --- |",
    ...result.links.map((l) => `| ${l.score ?? "PENDENTE"} | ${cell(l.title)} | ${cell(l.newsletter)} | ${cell(l.destino)} | ${cell(l.url)} |`)];
  writeFileSync(resolve(internal, "newsletter-intake-gate.md"), report.join("\n") + "\n");
  console.log(JSON.stringify({threads: result.rows.length, links: result.links.length, missing_scores: result.links.filter((l) => l.score === null).length, missing_titles: result.links.filter((l) => !l.title.trim() || l.title.startsWith("(newsletter:")).length, pending_senders: result.pending_senders, discovery: {...result.discovery, oferecidos: result.discovery.oferecidos.length}, warnings}));
  if (flags.has("require-scores") && missing.length) process.exitCode = 1;
}
if (isMainModule(import.meta.url)) {
  try { main(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
