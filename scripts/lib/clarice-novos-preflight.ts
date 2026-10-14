/**
 * clarice-novos-preflight.ts (#10157) — núcleo PURO da pré-conferência do
 * `cloudflare-preview.html` que os envios `novos` das 09:00/18:00 leem.
 *
 * Contexto: o HTML vive em `data/monthly/{ciclo}/_internal/` (OneDrive, fora
 * do git) e pode ser regenerado numa máquina enquanto a task
 * `Diaria-Clarice-Novos` roda em outra (`300`). Se o sync atrasar, o envio sai
 * com a versão antiga, sem erro nem aviso. Este módulo só ANALISA texto — não
 * lê disco, não chama rede, não grava nada; a CLI
 * (`scripts/clarice-novos-preflight.ts`) cuida de I/O.
 */
import { createHash } from "node:crypto";
import { groupKeyFromCampaignName } from "./clarice-wave-plan.ts";
import { NOVOS_CAMPAIGN_NAME_PREFIX } from "./clarice-novos-state.ts";

/**
 * Hosts que servem `/img/{key}` a partir do KV `POLL` (ver
 * `scripts/lib/shared/kv-image.ts`, #7657): `eia.diar.ia.br` (URL histórica,
 * permanente), `diar.ia.br` (mesma origem do site) e o host workers.dev do
 * Worker `poll`. Imagem fora disso (Drive, path local, `data:`) não é do KV.
 */
const KV_IMAGE_SRC_RE = /^https:\/\/(?:eia\.diar\.ia\.br|diar\.ia\.br|poll\.diaria\.workers\.dev)\/img\/[^/?#\s]+$/;

export function isKvImageUrl(src: string): boolean {
  return KV_IMAGE_SRC_RE.test(src.trim());
}

/** Decodifica as entidades HTML comuns — o suficiente pra casar um marcador
 *  passado em texto plano (`dizendo "quero"`) contra `dizendo &quot;quero&quot;`. */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Normaliza aspas tipográficas pra retas e colapsa espaços — o marcador vem
 *  da linha de comando (aspas retas), o HTML pode ter as curvas. */
function normalizeForMatch(s: string): string {
  return s
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? "";
}

function textOf(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    const t = decodeHtmlEntities(stripTags(m[1])).replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
}

/** Resumo do conteúdo editorial que importa comparar entre duas versões. */
export interface PreviewSummary {
  /** `<title>` do documento. */
  title: string | null;
  /** `<h2>` — títulos dos destaques. */
  headlines: string[];
  /** `<h3>` — títulos das caixas (CTA, livros, Clarice, É IA?). */
  boxes: string[];
  /** `alt` das `<img>` — legendas das imagens. */
  captions: string[];
}

export function summarizePreviewHtml(html: string): PreviewSummary {
  const titles = textOf(html, "title");
  const captions: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const alt = attr(m[0], "alt");
    if (alt != null && alt.trim()) captions.push(decodeHtmlEntities(alt).trim());
  }
  return {
    title: titles[0] ?? null,
    headlines: textOf(html, "h2"),
    boxes: textOf(html, "h3"),
    captions,
  };
}

export interface ImageCheck {
  total: number;
  nonKv: string[];
}

export interface PreflightAnalysis {
  sha256: string;
  bytes: number;
  images: ImageCheck;
  /** Quantas setas `→`/`←` chegam ao leitor (#9721 — deve ser 0). */
  arrows: number;
  /** Quantos `href` carregam `utm_source=clarice`. */
  utmClariceLinks: number;
  /** Links pro próprio site (`diar.ia.br`) SEM `utm_source=clarice` — aviso, não falha. */
  siteLinksWithoutUtm: string[];
  expect: { marker: string; found: boolean }[];
  summary: PreviewSummary;
}

export function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function analyzePreviewHtml(html: string, expectMarkers: string[] = []): PreflightAnalysis {
  const srcs: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    srcs.push(attr(m[0], "src") ?? "");
  }
  const nonKv = srcs.filter((s) => !isKvImageUrl(decodeHtmlEntities(s)));

  const hrefs: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const h = attr(m[0], "href");
    if (h != null) hrefs.push(decodeHtmlEntities(h));
  }
  const utmClariceLinks = hrefs.filter((h) => /[?&]utm_source=clarice(?:&|#|$)/.test(h)).length;
  const siteLinksWithoutUtm = hrefs.filter(
    (h) => /^https?:\/\/(?:www\.)?diar\.ia\.br(?:[/?#]|$)/i.test(h) && !/[?&]utm_source=clarice(?:&|#|$)/.test(h),
  );

  const arrows = (decodeHtmlEntities(html).match(/[→←]/g) ?? []).length;

  const rawNorm = normalizeForMatch(html);
  const decodedNorm = normalizeForMatch(decodeHtmlEntities(html));
  const textNorm = normalizeForMatch(decodeHtmlEntities(stripTags(html)));
  const expect = expectMarkers.map((marker) => {
    const m = normalizeForMatch(marker);
    return { marker, found: rawNorm.includes(m) || decodedNorm.includes(m) || textNorm.includes(m) };
  });

  return {
    sha256: sha256OfText(html),
    bytes: Buffer.byteLength(html, "utf8"),
    images: { total: srcs.length, nonKv },
    arrows,
    utmClariceLinks,
    siteLinksWithoutUtm,
    expect,
    summary: summarizePreviewHtml(html),
  };
}

export interface ListDiff {
  added: string[];
  removed: string[];
}

export interface SummaryDiff {
  titleChanged: { from: string | null; to: string | null } | null;
  headlines: ListDiff;
  boxes: ListDiff;
  captions: ListDiff;
  changed: boolean;
}

function listDiff(from: string[], to: string[]): ListDiff {
  const a = new Set(from);
  const b = new Set(to);
  return { added: to.filter((x) => !a.has(x)), removed: from.filter((x) => !b.has(x)) };
}

export function diffSummaries(from: PreviewSummary, to: PreviewSummary): SummaryDiff {
  const titleChanged = from.title !== to.title ? { from: from.title, to: to.title } : null;
  const headlines = listDiff(from.headlines, to.headlines);
  const boxes = listDiff(from.boxes, to.boxes);
  const captions = listDiff(from.captions, to.captions);
  const changed =
    titleChanged != null ||
    [headlines, boxes, captions].some((d) => d.added.length > 0 || d.removed.length > 0);
  return { titleChanged, headlines, boxes, captions, changed };
}

/** Campanha mínima que `/api/campaigns` do dashboard devolve (só leitura). */
export interface DashboardCampaign {
  id: number;
  name: string;
  subject?: string;
  status?: string;
  sentDate?: string | null;
}

/**
 * Última campanha `novos` JÁ ENVIADA (por `sentDate` desc), identificada pela
 * KEY extraída do nome real (`Clarice {yymm} grupo:novos-…`) — mesmo critério
 * de `fetchSentCampaignsByPrefix` em `clarice-novos-html-state.ts`.
 */
export function pickLastSentNovosCampaign(campaigns: DashboardCampaign[]): DashboardCampaign | null {
  const novos = campaigns.filter((c) => {
    if (c.status && c.status !== "sent") return false;
    if (!c.sentDate) return false;
    const key = groupKeyFromCampaignName(c.name ?? "");
    return key != null && key.startsWith(NOVOS_CAMPAIGN_NAME_PREFIX);
  });
  novos.sort((a, b) => Date.parse(b.sentDate ?? "") - Date.parse(a.sentDate ?? ""));
  return novos[0] ?? null;
}

export interface PreflightInput {
  cycle: string;
  htmlPath: string;
  /** `null` = arquivo ausente. */
  html: string | null;
  mtime: Date | null;
  expectMarkers: string[];
  /** SHA-256 esperado (copiado da máquina onde o HTML foi gerado). */
  expectSha?: string;
  /** O arquivo precisa ter mtime >= esta data (ex.: hora da regeneração). */
  newerThan?: Date;
  /** HTML de referência (versão anterior) pra listar o que mudou. */
  baselineHtml?: string | null;
  /** Última campanha `novos` enviada (dashboard) + assunto que o próximo envio vai usar. */
  lastSent?: DashboardCampaign | null;
  resolvedSubject?: string | null;
}

export interface PreflightResult {
  ok: boolean;
  failures: string[];
  warnings: string[];
  analysis: PreflightAnalysis | null;
  diff: SummaryDiff | null;
  reportLine: string;
}

export function evaluatePreflight(input: PreflightInput): PreflightResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  if (input.html == null) {
    failures.push(`arquivo ausente: ${input.htmlPath}`);
    return {
      ok: false,
      failures,
      warnings,
      analysis: null,
      diff: null,
      reportLine: `clarice-novos preflight ${input.cycle}: FALHA — HTML ausente (${input.htmlPath})`,
    };
  }

  const a = analyzePreviewHtml(input.html, input.expectMarkers);

  if (a.images.total === 0) failures.push("nenhuma <img> no HTML");
  if (a.images.nonKv.length > 0) {
    failures.push(`${a.images.nonKv.length} imagem(ns) fora do KV: ${a.images.nonKv.slice(0, 5).join(", ")}`);
  }
  if (a.arrows > 0) failures.push(`${a.arrows} seta(s) → / ← no HTML (#9721)`);
  if (a.utmClariceLinks === 0) failures.push("nenhum link com utm_source=clarice");
  if (a.siteLinksWithoutUtm.length > 0) {
    warnings.push(`${a.siteLinksWithoutUtm.length} link(s) pro diar.ia.br sem utm_source=clarice: ${a.siteLinksWithoutUtm.slice(0, 3).join(", ")}`);
  }
  const missing = a.expect.filter((e) => !e.found).map((e) => e.marker);
  if (missing.length > 0) failures.push(`marcador(es) esperado(s) ausente(s) — arquivo desatualizado? ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
  if (input.expectSha && input.expectSha.toLowerCase() !== a.sha256) {
    failures.push(`sha256 diverge do esperado (${input.expectSha.slice(0, 12)}… esperado, ${a.sha256.slice(0, 12)}… no disco) — sync atrasado?`);
  }
  if (input.newerThan && input.mtime && input.mtime.getTime() < input.newerThan.getTime()) {
    failures.push(`mtime ${input.mtime.toISOString()} anterior a ${input.newerThan.toISOString()} — arquivo desatualizado`);
  }

  let diff: SummaryDiff | null = null;
  if (input.baselineHtml != null) {
    diff = diffSummaries(summarizePreviewHtml(input.baselineHtml), a.summary);
  }

  if (input.lastSent) {
    const ls = input.lastSent;
    const yymm = /^Clarice\s+(\d{4})\b/i.exec(ls.name)?.[1] ?? null;
    const cycleYymm = input.cycle.slice(0, 4);
    if (yymm && yymm !== cycleYymm) {
      warnings.push(`última campanha novos enviada (${ls.name}) é do conteúdo ${yymm}; o próximo envio usa ${cycleYymm}`);
    }
    if (input.resolvedSubject && ls.subject && ls.subject !== input.resolvedSubject) {
      warnings.push(`assunto mudou desde o último envio: ${JSON.stringify(ls.subject)} → ${JSON.stringify(input.resolvedSubject)}`);
    }
  }

  const ok = failures.length === 0;
  const expectPart = a.expect.length > 0 ? ` · expect ${a.expect.filter((e) => e.found).length}/${a.expect.length}` : "";
  const mtimePart = input.mtime ? ` mtime ${input.mtime.toISOString()}` : "";
  const diffPart = diff ? (diff.changed ? " · mudou vs referência" : " · igual à referência") : "";
  const reportLine =
    `clarice-novos preflight ${input.cycle}: ${ok ? "OK" : "FALHA"} — sha256 ${a.sha256.slice(0, 12)}… ${a.bytes}B${mtimePart}` +
    ` · ${a.images.total} img (${a.images.nonKv.length === 0 ? "KV ok" : `${a.images.nonKv.length} fora do KV`})` +
    ` · ${a.arrows} seta · ${a.utmClariceLinks} link utm_source=clarice${expectPart}${diffPart}` +
    (ok ? "" : ` · ${failures.length} falha(s)`);

  return { ok, failures, warnings, analysis: a, diff, reportLine };
}
