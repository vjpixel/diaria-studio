#!/usr/bin/env tsx
/**
 * build-link-ctr.ts
 * Builds a link-level CTR table across all 164 Beehiiv posts.
 * Output: data/link-ctr-table.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';
// #1844: classificador de links extraído pra módulo dedicado (puro, testável).
import { categorize } from './lib/link-ctr-categorize.ts';
import { DIARIA_FACEBOOK_PAGE_SLUG } from './lib/canonical-urls.ts'; // #2695 fonte única

const POSTS_DIR = path.join(process.cwd(), 'data/beehiiv-cache/posts');
const OUT_CSV = path.join(process.cwd(), 'data/link-ctr-table.csv');

// ─── Noise filters ────────────────────────────────────────────────────────────

function baseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

export function isEditorial(url: string): boolean {
  let host: string, pathname: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    pathname = u.pathname;
  } catch { return false; }

  // Skip beehiiv infrastructure
  if (host.includes('beehiiv.com')) return false;

  // Skip social sharing widgets
  const socialShare = [
    'facebook.com/sharer', 'twitter.com/intent', 'threads.net/intent',
    'linkedin.com/sharing', 'x.com/intent',
  ];
  if (socialShare.some(s => url.includes(s))) return false;

  // Skip own social channels
  const ownChannels = [
    DIARIA_FACEBOOK_PAGE_SLUG, 'linkedin.com/company/diar.ia.br',
    'youtube.com/@diaria', 'instagram.com/diaria',
  ];
  if (ownChannels.some(s => url.includes(s))) return false;

  // Skip ad/affiliate/sorteador noise
  const noisePatterns = [
    'sorteador.com.br', '_bhiiv=opp_', 'clarice.ai', 'wispr.flow',
    'wispr.ai', 'wisprflow.ai', 'unsubscribe', 'preferences',
    'beehiivstatus.com', 'omnivery_honeypot', 'archive.is',
  ];
  if (noisePatterns.some(s => url.includes(s))) return false;

  // Skip own infra + non-editorial utility links (#1567 audit, finding G):
  // the poll-vote Workers, Google Meet invites e atribuição Creative Commons
  // não são links editoriais — vazavam como rows "Outro" e deslocavam fontes
  // reais do Top-15 de domínios que o scorer lê.
  if (host.endsWith('.workers.dev')) return false; // poll.diaria.workers.dev etc.
  if (host === 'meet.google.com') return false;
  if (host === 'creativecommons.org') return false;

  // Skip referral links (pplx.ai/username style)
  if (host === 'pplx.ai' && /^\/[a-z0-9_-]+$/i.test(new URL(url).pathname)) return false;

  // Skip broken/garbled URLs (contain spaces or quotes — parsing artifacts)
  if (url.includes(' ') || url.includes('"')) return false;

  // Skip Amazon product links (not editorial)
  if (host === 'amzn.to' || (host === 'amazon.com.br' && pathname.includes('/dp/'))) return false;

  // Skip LinkedIn profile pages (not editorial)
  if (host === 'linkedin.com' && /^\/in\//.test(pathname)) return false;

  // Skip broken double-protocol URLs
  if (/^https?:\/\/https?[:/]/.test(url)) return false;
  if (host === 'https' || host === 'http') return false;

  // Skip bare platform domains with no editorial path
  if (host === 'google.com' && pathname === '/') return false;
  if (host === 'crypto.com' && pathname === '/') return false;

  // Skip job listings, portfolios, and link shorteners to noise
  if (host === 'amazon.jobs') return false;
  if (host === 'gileslaurent.com') return false;
  if (host === 'resulta.do') return false;

  // Skip non-AI editorial filler
  if (pathname.includes('easter-eggs')) return false;
  if (pathname.includes('moltbook-was-peak-ai-theater')) return false;

  return true;
}

// ─── Origin (BR / INT) ────────────────────────────────────────────────────────

/**
 * Classifica a origem (BR/INT) de UM link a partir da evidência do PRÓPRIO link
 * (anchor + section + context) e do domínio.
 *
 * #1567 audit (finding B): antes o `signal` incluía o `title` do POST (a manchete
 * líder, idêntica pra todos os links da edição). Numa edição com lead brasileiro,
 * TODO link secundário/internacional herdava o keyword BR e virava BR (~30% das
 * rows BR eram domínios estrangeiros mislabeled). O fix: o caller NÃO passa mais
 * o title; a origem vem só da evidência por-link + um override forte por TLD `.br`.
 * Tokens ambíguos que geravam falsos positivos ('senado'→'senador americano',
 * ' usp'→"unique selling proposition", ' r$'→"r$ values") foram endurecidos.
 */
export function classifyOrigin(signal: string, domain = ''): 'BR' | 'INT' {
  // Domínio .br (.com.br, .gov.br, .org.br …) é sinal forte de fonte/conteúdo BR.
  const host = domain.toLowerCase().replace(/^www\./, '');
  if (/(^|\.)br$/.test(host)) return 'BR';

  const s = signal.normalize('NFC').toLowerCase();
  const brStrong = [
    'brasil', 'brasileir', 'brazil',
    'são paulo', 'brasília', 'rio de janeiro', 'belo horizonte',
    'curitiba', 'porto alegre', 'recife', 'salvador', 'fortaleza',
    'minas gerais', 'paraná', 'bahia', 'pernambuco',
    'lula', 'governo federal', 'governo brasileiro', 'planalto',
    'anvisa', 'bndes', 'anatel', 'cade',
    'câmara dos deputados', 'congresso nacional', 'pgr',
    'fapesp', 'cnpq', 'capes', 'embrapa', 'serpro',
    'no país', 'no brasil', 'ao brasil', 'do brasil', 'pelo brasil',
    'mercado nacional',
    // antes eram tokens curtos com falsos positivos (#1567 finding B):
    'senado federal', 'senado brasileiro', // 'senado' cru pegava 'senador americano'
    'unicamp', 'ufrj', 'ufrn', 'ufmg',
  ];
  if (brStrong.some(k => s.includes(k))) return 'BR';

  // Tokens ambíguos: só com word boundary / co-sinal de moeda.
  //  - \bstf\b: STF (Supremo) — token raro em inglês.
  //  - R$ só conta como moeda quando seguido de dígito ("R$ 23 bi"), não "r$ values".
  //  ('usp' cru foi removido: colidia com "unique selling proposition"; conteúdo
  //   da USP real quase sempre traz 'são paulo'/'brasil' ou domínio .br.)
  if (/\bstf\b/.test(s)) return 'BR';
  if (/\br\$\s*\d/.test(s)) return 'BR';

  return 'INT';
}

// ─── Incremental skip identity (#1567 finding H) ───────────────────────────────

/** Chave de identidade de um post no CSV incremental: data + título. */
export function postKey(date: string, title: string): string {
  return `${date} ${title}`;
}

/**
 * Decide se um post deve ser pulado no modo incremental.
 *
 * #1567 audit (finding H): o skip antigo era `date <= lastDate`, que derrubava
 * PERMANENTEMENTE uma 2ª edição publicada na MESMA data quando ela só amadurecia
 * (>7d) num run posterior — a irmã `date == lastDate` era pulada e seus links
 * editoriais nunca entravam no CSV. Agora: `date < lastDate` ainda pula por
 * eficiência (runs anteriores), mas no boundary `date == lastDate` consultamos o
 * set de (data,título) já no CSV, então uma irmã de mesma data ainda não
 * processada NÃO é pulada.
 */
export function shouldSkipPost(opts: {
  date: string;
  title: string;
  isBootstrap: boolean;
  lastDate: string;
  processedKeys: Set<string>;
}): boolean {
  const { date, title, isBootstrap, lastDate, processedKeys } = opts;
  if (isBootstrap) return false;
  if (date < lastDate) return true;
  if (date === lastDate && processedKeys.has(postKey(date, title))) return true;
  return false;
}

// #1844: classificador categorize() + negociosSubcategory → scripts/lib/link-ctr-categorize.ts.

// ─── HTML link extraction ─────────────────────────────────────────────────────

interface LinkEntry {
  url: string;
  baseUrl: string;
  anchor: string;
  sectionTitle: string; // nearest <b> heading above the link
  context: string; // surrounding paragraph text for richer signal
}

// Boilerplate <b> texts that are NOT section titles
const BOILERPLATE_B = [
  'por que isso importa', 'é ai?', 'é ai', 'leia online', 'saiba mais',
  'aprofunde', 'aqui', 'clique', 'veja', 'acesse',
];

function cleanText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function extractLinks(html: string): LinkEntry[] {
  const entries: LinkEntry[] = [];
  const seen = new Set<string>();

  // Strip <style> and <head> blocks first to avoid CSS leaking into <b> matches
  const bodyHtml = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '');

  // Build a token stream: alternating between <b> tags and <a> tags
  // (?=[\s>\/]) ensures we match <b> and <a> but NOT <base>, <body>, <aside>, etc.
  const tokenRegex = /<(b|a)(?=[\s>\/])([^>]*)>([\s\S]*?)<\/\1>/gi;
  let currentSection = '';
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(bodyHtml)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const inner = match[3];

    if (tag === 'b') {
      const text = cleanText(inner);
      const lower = text.toLowerCase();
      // Accept as section title if:
      // - long enough to be a headline (10-150 chars)
      // - not boilerplate
      // - not ending with ":" (editorial labels like "Como usar:", "Glossário:")
      // - not CSS-like content
      // - starts with uppercase (headlines) or common AI company names
      const looksLikeLabel = /:\s*$/.test(text);
      const looksLikeCss = text.includes('{') || text.includes(':root');
      const tooLong = text.length > 150;
      // Body emphasis starts with article/pronoun — not a headline
      const looksLikeBodyBold = /^(a |o |as |os |um |uma |ao |aos |às |do |da |dos |das |no |na |nos |nas |em |de |que |se |por |para |com |quando |porque |isso |este |esta |estes |estas |esse |essa )/i.test(text);
      if (
        text.length >= 10 &&
        !tooLong &&
        !looksLikeLabel &&
        !looksLikeCss &&
        !looksLikeBodyBold &&
        !BOILERPLATE_B.some(b => lower.startsWith(b))
      ) {
        currentSection = text;
      }
      continue;
    }

    // tag === 'a'
    const hrefMatch = match[2].match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const rawUrl = hrefMatch[1].trim();
    if (!rawUrl || rawUrl.startsWith('mailto:') || rawUrl.startsWith('#')) continue;
    if (!isEditorial(rawUrl)) continue;

    const bu = baseUrl(rawUrl);
    if (seen.has(bu)) continue;
    seen.add(bu);

    const anchor = cleanText(inner);

    // Extract surrounding paragraph context (300 chars before link in bodyHtml)
    const linkIdx = match.index!;
    const ctxStart = Math.max(0, linkIdx - 400);
    const ctxEnd = Math.min(bodyHtml.length, linkIdx + 200);
    const context = cleanText(bodyHtml.substring(ctxStart, ctxEnd));

    entries.push({ url: rawUrl, baseUrl: bu, anchor, sectionTitle: currentSection, context });
  }

  return entries;
}

// ─── Match link to click stats ────────────────────────────────────────────────

interface ClickStat {
  verified_clicks: number;
  unique_verified_clicks: number;
  unique_clicks: number;
}

export function matchClick(bu: string, clicks: any[]): ClickStat {
  const zero: ClickStat = { verified_clicks: 0, unique_verified_clicks: 0, unique_clicks: 0 };
  if (!clicks || clicks.length === 0) return zero;

  // baseUrl() strips the entire query string, so per-subscriber link variants
  // (bhcl_id, sid, utm, …) collapse to the same base. Beehiiv emits one click
  // row PER variant, so a split link must SUM across ALL matching rows — a single
  // .find() recorded only the first row's clicks and undercounted real editorial
  // CTR (#1567 audit, finding C). Exact-base bucket still takes precedence over
  // the fuzzy bucket; we sum within whichever bucket matches.
  const sum = (rows: any[]): ClickStat =>
    rows.reduce(
      (acc, c) => ({
        verified_clicks: acc.verified_clicks + (c.email?.verified_clicks ?? 0),
        unique_verified_clicks: acc.unique_verified_clicks + (c.email?.unique_verified_clicks ?? 0),
        unique_clicks: acc.unique_clicks + (c.email?.unique_clicks ?? 0),
      }),
      { ...zero },
    );

  const buTrim = bu.replace(/\/$/, '');
  const exact = clicks.filter(c => {
    const cb = c.base_url || baseUrl(c.url);
    return cb === bu || cb.replace(/\/$/, '') === buTrim;
  });
  if (exact.length > 0) return sum(exact);

  // Fuzzy: match by stripping protocol + trailing slash
  const normalize = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const buNorm = normalize(bu);
  const fuzzy = clicks.filter(c => normalize(c.base_url || baseUrl(c.url)) === buNorm);
  if (fuzzy.length > 0) return sum(fuzzy);

  return zero;
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function csvEscape(val: string | number): string {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface Row {
  date: string;
  post_title: string;
  section_title: string;
  anchor: string;
  base_url: string;
  domain: string;
  unique_opens: number;
  verified_clicks: number;
  unique_verified_clicks: number;
  ctr_pct: string;
  category: string;
  origin: 'BR' | 'INT';
}

function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.error(`Error: ${POSTS_DIR} not found. Run the Beehiiv cache sync first.`);
    process.exit(1);
  }

  const header = [
    'date', 'post_title', 'section_title', 'anchor', 'base_url', 'domain',
    'unique_opens', 'verified_clicks', 'unique_verified_clicks', 'ctr_pct', 'category', 'origin'
  ];

  // Incremental: read existing CSV to find the most recent date already processed
  let existingLines: string[] = [];
  let lastDate = '';
  // #1567 finding H: identidade (data,título) dos posts já no CSV — usada pra não
  // pular uma 2ª edição de mesma data que só amadureceu num run posterior.
  const processedKeys = new Set<string>();
  const isBootstrap = !fs.existsSync(OUT_CSV);

  if (!isBootstrap) {
    const rawExisting = fs.readFileSync(OUT_CSV, 'utf8');
    const existing = rawExisting.split('\n');
    const oldHeader = existing[0] ?? '';
    // If column schema changed (e.g. removed 'url' column), re-bootstrap
    if (oldHeader !== header.join(',')) {
      console.log('CSV schema changed — re-bootstrapping.');
    } else {
      existingLines = existing.slice(1).filter(Boolean); // skip header
      // Find most recent date in existing data (first column)
      for (const line of existingLines) {
        const date = line.split(',')[0];
        if (date > lastDate) lastDate = date;
      }
      // Parse properly (post_title pode ter vírgulas) pra montar o set de identidade.
      const parsed = Papa.parse<Record<string, string>>(rawExisting, {
        header: true,
        skipEmptyLines: true,
      });
      for (const rec of parsed.data) {
        if (rec.date) processedKeys.add(postKey(rec.date, rec.post_title ?? ''));
      }
    }
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f !== 'index.json');

  const posts: any[] = files.map(f =>
    JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8'))
  );

  // Sort by publish_date ascending
  posts.sort((a, b) => (a.publish_date ?? 0) - (b.publish_date ?? 0));

  const newRows: Row[] = [];
  let processed = 0;
  let skipped = 0;

  const MIN_AGE_DAYS = 7;
  const cutoff = Date.now() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  let tooRecent = 0;
  let alreadyProcessed = 0;
  let noPublishDate = 0;

  for (const post of posts) {
    if (post.status !== 'confirmed') { skipped++; continue; }

    // Skip editions published less than 7 days ago (CTR still settling)
    if (post.publish_date && post.publish_date * 1000 > cutoff) {
      tooRecent++;
      continue;
    }

    // #864: posts confirmed mas sem publish_date (raro mas possível) eram
    // contados em alreadyProcessed via comparação de string `'' <= lastDate`
    // — counter inflado e label enganoso. Tratar como categoria distinta.
    if (!post.publish_date) {
      noPublishDate++;
      continue;
    }

    const date = new Date(post.publish_date * 1000).toISOString().slice(0, 10);
    const title = post.title ?? '';

    // Incremental: skip posts already in the CSV (#1567 finding H — por identidade
    // (data,título) no boundary, não só `date <= lastDate`, pra não derrubar uma
    // 2ª edição de mesma data que amadureceu depois).
    if (shouldSkipPost({ date, title, isBootstrap, lastDate, processedKeys })) {
      alreadyProcessed++;
      continue;
    }
    const uniqueOpens = post.stats?.email?.unique_opens ?? 0;
    const clicks = post.stats?.clicks ?? [];

    const html = post.content?.free?.email ?? post.content?.free?.web ?? '';
    if (!html) { skipped++; continue; }

    const links = extractLinks(html);

    for (const link of links) {
      const clickStat = matchClick(link.baseUrl, clicks);
      const ctr = uniqueOpens > 0
        ? ((clickStat.unique_verified_clicks / uniqueOpens) * 100).toFixed(2)
        : '0.00';

      let domain = '';
      try { domain = new URL(link.baseUrl).hostname.replace(/^www\./, ''); } catch {}

      newRows.push({
        date,
        post_title: title,
        section_title: link.sectionTitle,
        anchor: link.anchor,
        base_url: link.baseUrl,
        domain,
        unique_opens: uniqueOpens,
        verified_clicks: clickStat.verified_clicks,
        unique_verified_clicks: clickStat.unique_verified_clicks,
        ctr_pct: ctr,
        category: categorize(link.baseUrl, link.anchor, link.sectionTitle, title, link.context),
        // #1567 finding B: NÃO incluir `title` (manchete do post) — ele vazava o
        // ângulo BR do lead pra todos os links. Origem vem da evidência por-link + domínio.
        origin: classifyOrigin(link.anchor + ' ' + link.sectionTitle + ' ' + link.context, domain),
      });
    }

    processed++;
  }

  // Write CSV: existing rows + new rows
  const newCsvLines = newRows.map(r => [
    r.date, r.post_title, r.section_title, r.anchor, r.base_url, r.domain,
    r.unique_opens, r.verified_clicks, r.unique_verified_clicks, r.ctr_pct, r.category, r.origin
  ].map(csvEscape).join(','));

  const allLines = [header.join(','), ...existingLines, ...newCsvLines];
  fs.writeFileSync(OUT_CSV, allLines.join('\n'), 'utf8');

  const totalRows = existingLines.length + newRows.length;
  const mode = isBootstrap ? 'bootstrap' : 'incremental';

  console.log(`\nDone (${mode}).`);
  console.log(`  New posts processed: ${processed}`);
  if (!isBootstrap) console.log(`  Posts already in CSV: ${alreadyProcessed}`);
  console.log(`  Posts skipped (draft/no HTML): ${skipped}`);
  console.log(`  Posts skipped (< ${MIN_AGE_DAYS} days old): ${tooRecent}`);
  if (noPublishDate > 0) {
    console.log(`  Posts skipped (no publish_date): ${noPublishDate}`);
  }
  console.log(`  New links added: ${newRows.length}`);
  console.log(`  Total link rows: ${totalRows}`);
  console.log(`  Output: ${OUT_CSV}`);

  // Summary stats for new rows only
  if (newRows.length > 0) {
    const byCategory: Record<string, { count: number; clicks: number; opens: number }> = {};
    for (const r of newRows) {
      if (!byCategory[r.category]) byCategory[r.category] = { count: 0, clicks: 0, opens: 0 };
      byCategory[r.category].count++;
      byCategory[r.category].clicks += r.unique_verified_clicks;
      byCategory[r.category].opens += r.unique_opens;
    }

    console.log('\nNovas links por categoria:');
    for (const [cat, stat] of Object.entries(byCategory).sort((a, b) => b[1].count - a[1].count)) {
      const avgCtr = stat.opens > 0 ? ((stat.clicks / stat.opens) * 100).toFixed(2) : '0.00';
      console.log(`  ${cat.padEnd(16)}: ${String(stat.count).padStart(4)} links | CTR médio ${avgCtr}%`);
    }
  } else if (!isBootstrap) {
    console.log('\nNenhuma edição nova para processar.');
  }
}

// CLI guard (#1567 audit): só roda main() quando invocado direto. Sem isto, um
// test que importe isEditorial/matchClick dispararia main() — que lê o cache
// Beehiiv e escreve o CSV — no CI (que não tem `data/`).
const _argv1 = process.argv[1]?.replaceAll('\\', '/') ?? '';
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, '')}`
) {
  main();
}
