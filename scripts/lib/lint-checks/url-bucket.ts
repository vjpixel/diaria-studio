/**
 * lint-checks/url-bucket.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Cluster coeso do lint core de newsletter: o modelo URL × seção/bucket.
 * - `lintNewsletter` (lint default — URL em seção secundária bate com o bucket
 *   do approved?),
 * - `checkSectionCounts` + `countItemsPerSection` (`--check section-counts`, #907),
 * - a infra compartilhada (`extractUrlsBySection`, `buildUrlBucketMap`, o mapping
 *   `SECTIONS`, normalização de URL pro JOIN newsletter↔approved).
 *
 * Tudo opera sobre o mesmo modelo, então mora junto (helpers privados ficam
 * encapsulados). `lint-newsletter-md.ts` re-exporta pra back-compat e o `main()`
 * importa as funções pro dispatch.
 */

import { checkStage2Caps, type ApprovedJson as CapsApprovedJson } from "../apply-stage2-caps.ts"; // #907
import {
  SECTIONS as SECTION_DEFS,
  sectionHeaderRegex,
} from "../section-naming.ts"; // #1737 fonte única de seções

// #1031: tipos locais reconciliados com central ApprovedJsonSchema
// (scripts/lib/schemas/edition-state.ts). url é optional pra suportar
// flat/nested highlights (#229) e runners_up que podem ter shape variado.
// Lógica abaixo já trata undefined defensivamente (`if (h.url)` etc).
export interface ApprovedArticle {
  url?: string;
  title?: string;
  // article nested (HighlightNestedSchema) — opcional, pra casos de runners_up
  article?: { url?: string; title?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ApprovedJson {
  highlights?: ApprovedArticle[];
  runners_up?: ApprovedArticle[];
  lancamento?: ApprovedArticle[];
  // #1691: buckets reais do 01-approved-capped.json são per-categoria
  // (pesquisa/noticias/tutorial/video), não per-seção. `radar` é aceito pra
  // forward-compat (e os fixtures de teste usam). Mapeados pra seção em
  // buildUrlBucketMap (pesquisa/noticias → RADAR, tutorial → USE MELHOR).
  radar?: ApprovedArticle[];
  pesquisa?: ApprovedArticle[];
  noticias?: ApprovedArticle[];
  tutorial?: ApprovedArticle[];
  video?: ApprovedArticle[];
  [key: string]: unknown;
}

// #1629: Bucket internal = section name na newsletter. #1691: + use_melhor, video.
export type Bucket = "lancamento" | "radar" | "use_melhor" | "video";

export interface SectionMapping {
  header: RegExp;
  bucket: Bucket;
  label: string;
}

// Headers podem ser plain (legacy) ou em **negrito** (#590). Aceita ambos
// pra backwards-compat com edições antigas + suporta o novo formato.
// #1569 / #1629: RADAR substitui PESQUISAS + OUTRAS NOTÍCIAS. Aliases legacy
// mantidos pra re-lint de edições antigas; novos lints emitem RADAR.
//
// #1737: a lista nome → bucket → label e o regex de header vêm de
// section-naming.ts (fonte única — antes esta era uma das 3 cópias). Forma
// exata preservada: bold opcional, sem captura, flags "mu", emoji prefix
// tight (range Unicode). `sectionHeaderRegex(pattern, {flags:"mu"})` produz
// o mesmo `^(?:\*\*)?<emoji>(?:<pattern>)(?:\*\*)?\s*$` de antes.
const SECTIONS: SectionMapping[] = SECTION_DEFS.map((s) => ({
  header: sectionHeaderRegex(s.pattern, { flags: "mu" }),
  bucket: s.bucket,
  label: s.label,
}));

const SECTION_BREAK_RE = /^---\s*$/;
// Match URL up to whitespace OR markdown delimiter (`)`, `]`, `>`)
// para que [url](url) extraia 2 instâncias da mesma URL e o dedup capture.
const URL_RE = /https?:\/\/[^\s\)\]>]+/g;

// #1691 review: pro JOIN newsletter↔approved, ignora SÓ o fragmento (`#...`) —
// é client-side, nunca identifica recurso diferente (RFC 3986 §3.5). Caso real
// 260521: approved tinha `.../claude-code-rce-flaw/#amp` e a newsletter a versão
// limpa → match exato falhava e a URL aprovada virava falso "missing". Não
// normaliza trailing-slash/query/www (podem ser semânticos) — mantém o espírito
// "URLs opacas" (#720), relaxando só o que é comprovadamente seguro.
function normalizeUrlForMatch(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

export interface LintError {
  section: string;
  expected_bucket: Bucket;
  url: string;
  line: number;
  found_in_bucket: Bucket | "highlights" | "missing" | "duplicate";
  title?: string;
  // #5757: só presente quando found_in_bucket === "duplicate" — todos os
  // buckets-destino distintos que a URL reivindica simultaneamente em
  // 01-approved.json (ver duplicateBucketUrls em buildUrlBucketMap abaixo).
  duplicate_buckets?: Bucket[];
}

export interface LintResult {
  ok: boolean;
  errors: LintError[];
  warnings: string[];
}

function isSectionHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 5) return false;
  if (!/^[A-ZÇÃÕÁÉÍÓÚÊÔ ]+$/.test(trimmed)) return false;
  return true;
}

/**
 * Extrai URLs por seção. Mapping: section.label → array de { url, line }.
 */
export function extractUrlsBySection(
  md: string,
): Record<string, Array<{ url: string; line: number }>> {
  // #5084: normaliza CRLF→LF antes do split — sem isso, uma linha com \r
  // sobrando no fim quebra HIGHLIGHT_HEADER_RE (que usa `$` sem /m, exigindo
  // fim de string exato; `.` não casa \r).
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: Record<string, Array<{ url: string; line: number }>> = {};

  let currentSection: SectionMapping | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Section header detected?
    const matched = SECTIONS.find((s) => s.header.test(raw));
    if (matched) {
      currentSection = matched;
      if (!out[matched.label]) out[matched.label] = [];
      continue;
    }

    // Section break ends current section
    if (currentSection && SECTION_BREAK_RE.test(raw)) {
      currentSection = null;
      continue;
    }

    // Non-section header (e.g., DESTAQUE) ends current section
    if (currentSection && isSectionHeaderLine(raw) && raw.trim() !== currentSection.label) {
      currentSection = null;
      // Re-evaluate this line: does it match a different section?
      const reMatch = SECTIONS.find((s) => s.header.test(raw));
      if (reMatch) {
        currentSection = reMatch;
        if (!out[reMatch.label]) out[reMatch.label] = [];
      }
      continue;
    }

    if (currentSection) {
      const matches = raw.matchAll(URL_RE);
      for (const m of matches) {
        const url = m[0].replace(/[).,;]+$/, "");
        out[currentSection.label].push({ url, line: i + 1 });
      }
    }
  }

  return out;
}

/**
 * Mapa { url → bucket } a partir do approved JSON. Highlights ficam
 * separados (não erro se aparecem em qualquer seção — destaques podem
 * vir de qualquer bucket original).
 */
export function buildUrlBucketMap(
  approved: ApprovedJson,
): {
  byUrl: Map<string, { bucket: Bucket | "highlights"; title?: string }>;
  // #5757: URLs que reivindicam >1 bucket-destino DISTINTO simultaneamente em
  // 01-approved.json (ex: mesma URL em `radar` E `use_melhor`) — sempre um
  // bug de estado (um artigo pertence a UMA seção só), nunca decisão
  // editorial legítima. Achado real: pedido do editor pra "mover item entre
  // buckets" no gate do Stage 4 adicionou ao bucket novo sem remover do
  // antigo na cópia uncapped. Sem este rastreio, `byUrl` (abaixo) silenciava
  // a duplicata — ficava só com o 1º bucket na ordem de
  // APPROVED_BUCKET_TO_SECTION — e o sintoma virava um falso-positivo
  // confuso de "seção errada" no lint principal (a URL nunca "sumia": ela
  // sempre existia em algum bucket, só não no que o mismatch apontava).
  duplicateBucketUrls: Map<string, { buckets: Bucket[]; title?: string }>;
} {
  const byUrl = new Map<
    string,
    { bucket: Bucket | "highlights"; title?: string }
  >();
  const bucketsSeenByUrl = new Map<string, Set<Bucket>>();

  // Highlights primeiro — sobrescreve buckets se artigo é destaque.
  // #1691 review: highlights podem ter shape flat (h.url) OU nested
  // (h.article.url) — #229. Sem ler o nested, um destaque que reaparece numa
  // seção secundária era falsamente marcado "missing" (a regra #165 re-dispararia
  // o writer à toa). Mesmo padrão do pickEntry em canonical-urls.ts.
  for (const h of approved.highlights ?? []) {
    const url = h.url ?? h.article?.url;
    if (url) byUrl.set(normalizeUrlForMatch(url), { bucket: "highlights", title: h.title ?? h.article?.title });
  }

  // #1691: o 01-approved-capped.json usa buckets per-CATEGORIA
  // (pesquisa/noticias/tutorial/video), mas as SEÇÕES da newsletter são
  // per-bucket (RADAR = pesquisa+noticias, USE MELHOR = tutorial). Mapeia
  // categoria → seção (mesma lógica do bucketOf em merge-scored-chunks). O
  // map antigo só lia ["lancamento","radar"] — e como approved não tem chave
  // `radar`, NENHUMA URL de pesquisa/noticias/tutorial/video era mapeada (todas
  // viravam "missing" se o lint chegasse a rodar). `radar` mantido pra
  // forward-compat + fixtures de teste.
  const APPROVED_BUCKET_TO_SECTION: Record<string, Bucket> = {
    lancamento: "lancamento",
    radar: "radar",
    pesquisa: "radar",
    noticias: "radar",
    // #1857: o pipeline (finalize-stage1 / 01-approved.json) grava a chave de
    // bucket `use_melhor`, não a chave de categoria `tutorial`. Sem este
    // mapeamento, URLs da seção USE MELHOR caíam em "missing" sempre que a
    // seção tinha conteúdo (mascarado enquanto a seção vinha vazia pelo #1632).
    use_melhor: "use_melhor",
    tutorial: "use_melhor", // back-compat: approveds antigos usavam a chave de categoria
    video: "video",
  };
  // Só seta se URL ainda não está como highlight (#1629)
  for (const [approvedKey, sectionBucket] of Object.entries(APPROVED_BUCKET_TO_SECTION)) {
    for (const a of (approved[approvedKey] as ApprovedArticle[] | undefined) ?? []) {
      const url = a.url ? normalizeUrlForMatch(a.url) : undefined;
      if (!url) continue;
      if (byUrl.get(url)?.bucket === "highlights") continue; // highlight sempre vence, não é duplicata (#1629)
      const seenBuckets = bucketsSeenByUrl.get(url) ?? new Set<Bucket>();
      seenBuckets.add(sectionBucket);
      bucketsSeenByUrl.set(url, seenBuckets);
      if (!byUrl.has(url)) {
        byUrl.set(url, { bucket: sectionBucket, title: a.title });
      }
    }
  }

  const duplicateBucketUrls = new Map<string, { buckets: Bucket[]; title?: string }>();
  for (const [url, buckets] of bucketsSeenByUrl) {
    if (buckets.size > 1) {
      duplicateBucketUrls.set(url, { buckets: [...buckets], title: byUrl.get(url)?.title });
    }
  }

  return { byUrl, duplicateBucketUrls };
}

export function lintNewsletter(
  md: string,
  approved: ApprovedJson,
): LintResult {
  const urlsBySection = extractUrlsBySection(md);
  const { byUrl, duplicateBucketUrls } = buildUrlBucketMap(approved);

  const errors: LintError[] = [];
  const warnings: string[] = [];

  // #5757: reporta duplicatas de bucket direto de 01-approved.json, sem
  // depender de onde (ou se) a URL aparece em 02-reviewed.md — o mismatch
  // por-seção abaixo só pega o caso em que a MD lista a URL numa seção
  // diferente do 1º bucket que `byUrl` guardou; se a MD só lista a URL na
  // seção do 1º bucket (a duplicata sobrando é a que NINGUÉM referencia no
  // texto), o mismatch por-seção nunca dispara e o approved.json corrompido
  // passaria batido.
  for (const [url, { buckets, title }] of duplicateBucketUrls) {
    errors.push({
      section: "(01-approved.json)",
      expected_bucket: buckets[0],
      url,
      line: 0,
      found_in_bucket: "duplicate",
      duplicate_buckets: buckets,
      title,
    });
  }

  for (const sec of SECTIONS) {
    const urls = urlsBySection[sec.label] ?? [];
    const seen = new Set<string>();
    for (const { url, line } of urls) {
      if (seen.has(url)) continue; // dedup markdown link [url](url)
      seen.add(url);
      const normalized = normalizeUrlForMatch(url);
      // Já reportado acima como duplicata de bucket — não repetir como
      // "seção errada" (mesma causa raiz, mensagem melhor já emitida).
      if (duplicateBucketUrls.has(normalized)) continue;
      const found = byUrl.get(normalized);
      if (!found) {
        errors.push({
          section: sec.label,
          expected_bucket: sec.bucket,
          url,
          line,
          found_in_bucket: "missing",
        });
        continue;
      }
      if (found.bucket === "highlights") {
        // Destaques podem aparecer em qualquer lugar — só warn
        warnings.push(
          `${sec.label} (linha ${line}): URL ${url} é destaque (rank). Geralmente destaque não duplica em seção secundária.`,
        );
        continue;
      }
      if (found.bucket !== sec.bucket) {
        errors.push({
          section: sec.label,
          expected_bucket: sec.bucket,
          url,
          line,
          found_in_bucket: found.bucket,
          title: found.title,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Conta itens distintos por seção secundária (LANÇAMENTOS / PESQUISAS /
 * OUTRAS NOTÍCIAS). Cada item = 1 URL única na seção. (#907)
 *
 * Reusa `extractUrlsBySection` mas dedup por URL (markdown link emite a
 * mesma URL 2x — `[url](url)` casa o regex 2 vezes).
 */
export interface SectionCounts {
  lancamento: number;
  radar: number;
  // #1693: USE MELHOR é só observabilidade (sem cap máximo documentado);
  // VÍDEOS é validado (≤ 2). Ambos contados pra completar o report.
  use_melhor: number;
  video: number;
}

export function countItemsPerSection(md: string): SectionCounts {
  const urlsBySection = extractUrlsBySection(md);
  const dedup = (entries: Array<{ url: string; line: number }> | undefined) => {
    if (!entries) return 0;
    return new Set(entries.map((e) => e.url)).size;
  };
  // #1569/#1629: RADAR substitui PESQUISAS + OUTRAS NOTÍCIAS. Soma todos os
  // 3 nomes (RADAR atual, PESQUISAS/OUTRAS NOTÍCIAS legacy pra parsear
  // newsletters históricas pré-#1569).
  const lancamento = dedup(urlsBySection["LANÇAMENTOS"]);
  const radarCurrent = dedup(urlsBySection["RADAR"]);
  const pesquisasLegacy = dedup(urlsBySection["PESQUISAS"]);
  const outrasNoticiasLegacy = dedup(urlsBySection["OUTRAS NOTÍCIAS"]);
  return {
    lancamento,
    radar: radarCurrent + pesquisasLegacy + outrasNoticiasLegacy,
    use_melhor: dedup(urlsBySection["USE MELHOR"]),
    video: dedup(urlsBySection["VÍDEOS"]),
  };
}

/**
 * Validador #907: verifica que cada seção secundária respeita o cap de #358.
 *
 * Lê o `01-approved.json` pra obter o número de destaques (entra na fórmula
 * de Outras Notícias). Conta itens no MD e compara com cap calculado.
 *
 * Retorna `ok: false` quando alguma seção excede cap. Editor (Pixel)
 * detectou em 260507: writer publicou 9 itens de Outras Notícias quando
 * cap esperado era 4.
 */
export interface SectionCountsResult {
  ok: boolean;
  counts: SectionCounts;
  caps: { lancamento: number; radar: number; video: number };
  destaques: number;
  violations: string[];
}

export function checkSectionCounts(
  md: string,
  approved: ApprovedJson,
): SectionCountsResult {
  const counts = countItemsPerSection(md);
  const dest = approved.highlights?.length ?? 0;
  // #1693: passa VÍDEOS pro cap check (≤ 2). USE MELHOR fica fora — sem cap
  // máximo documentado; o count vai no `counts` só pra observabilidade.
  const fakeApproved: CapsApprovedJson = {
    highlights: approved.highlights ?? [],
    lancamento: new Array(counts.lancamento),
    radar: new Array(counts.radar),
    video: new Array(counts.video),
  };
  const r = checkStage2Caps(fakeApproved);
  // dest used only via fakeApproved.highlights
  void dest;
  return {
    ok: r.ok,
    counts,
    caps: r.expectedCaps,
    destaques: dest,
    violations: r.violations,
  };
}
