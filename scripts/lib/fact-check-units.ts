/**
 * fact-check-units.ts (#14035)
 *
 * Fact-check incremental por UNIDADE no gate da Etapa 4. O carimbo do #11671
 * (`content_hash`) é um hash por arquivo inteiro: qualquer ajuste em
 * `02-reviewed.md` ou `03-social.md` deixava o fact-check inteiro defasado, e o
 * re-run despachava o fact-checker sobre os 3 destaques (uns 90 s e 400k de
 * entrada por dispatch, edição 261126). Aqui o carimbo ganha um hash por
 * unidade, e o re-run despacha só as unidades que mudaram.
 *
 * Unidades:
 *   - `d{N}`: o bloco `DESTAQUE N` da newsletter (do header até o próximo
 *     `---`) + as seções `## d{N}` e `## d{N}-cards` do social (inclusive as do
 *     `# Curto`) + as fontes do destaque (URL do approved, entrada do
 *     `manifest.json`, entradas do `extras.json`, cada uma com o hash do texto
 *     baixado: `d{N}.txt`, `d{N}-extra-{k}.txt`). Mudança no social do D{N}
 *     recheca o D{N} inteiro; fonte nova registrada pelo editor
 *     (`add-destaque-source.ts`) também. Um `---` DENTRO do destaque (texto de
 *     destaque depois dele) deixa a partição ambígua e o plano sai completo
 *     (#14197).
 *   - `pool`: o resto da newsletter (cabeçalho, boxes, LANÇAMENTOS, RADAR, USE
 *     MELHOR...) + a seção `## um` do social. Os claims `"secondary"` do
 *     fact-checker (#8992, #9900) pertencem a ela.
 *   - `global` (não é unidade a despachar): o que sobra do social fora de
 *     `d{N}`/`um` (preâmbulo, seção desconhecida). Mudou = re-check completo,
 *     porque não dá pra dizer de qual destaque é.
 *
 * Decisão do editor (#14035, 25/11/2026): aceita o afrouxamento de
 * granularidade do guard de defasagem do #11671 (claim que cruza destaques
 * pode ficar sem recheck). O que NÃO afrouxa: unidade alterada é sempre
 * rechecada (nunca reaproveita claim de unidade mudada), e o
 * `--check-blocking` / DEFASADO / exit 2 seguem lendo o `content_hash` do
 * arquivo inteiro contra o conteúdo final.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashContent } from "./fact-check-staleness.ts";
import { extraSourceFileName, readExtrasManifest } from "./fact-check-extra-sources.ts";
import { ALL_SECTION_NAMES_PATTERN, sectionHeaderRegex } from "./section-naming.ts";
import { canonicalize } from "./url-utils.ts";
import { POOL_SOURCES_DIR, readPoolSourcesManifest } from "./diaria/pool-sources.ts";

export const POOL_UNIT = "pool";

export interface FactCheckUnitHashes {
  /** `d1`..`d3` + `pool` → sha256 (16 hex). */
  units: Record<string, string>;
  /** Social fora de `d{N}`/`um`. Mudou = re-check completo. */
  global: string;
  /**
   * Partição ambígua do conteúdo ATUAL (bloco de destaque sem fim claro,
   * header de destaque repetido). Presente = o plano sai completo. Só o
   * conteúdo atual decide; nunca comparado entre carimbos.
   */
  ambiguous?: string;
}

/** Fonte de um destaque, só o que muda o veredito (sem `fetched_at`). */
export interface UnitSourceEntry {
  destaque: number;
  url: string;
  status?: string;
  completeness?: string;
  k?: number;
  /**
   * Hash do texto baixado que o fact-checker leria (`d{N}.txt` da fonte
   * principal, `d{N}-extra-{k}.txt` da extra). `null` sem arquivo legível;
   * ausente = não lido (testes puros).
   */
  textHash?: string | null;
}

/** Fonte já lida de um item do pool (`_internal/pool-sources/`, #13884). */
export interface PoolSourceFingerprint {
  url: string;
  status?: string;
  completeness?: string;
  /** Hash do texto que o fact-checker leria (null sem arquivo legível). */
  textHash: string | null;
}

export interface UnitSourceInputs {
  /** URL de cada destaque no `01-approved.json`, por posição. */
  approvedUrls: Array<string | undefined>;
  manifest: UnitSourceEntry[];
  extras: UnitSourceEntry[];
  /** Fontes lidas dos itens do pool; entram no hash do `pool` pelas URLs citadas nele. */
  poolSources?: PoolSourceFingerprint[];
}

const DESTAQUE_HEADER_RE = /^(?:\*\*)?DESTAQUE (\d+)\s*\|/;
const SEPARATOR_RE = /^-{3,}$/;
/**
 * Linha que só existe no corpo de um destaque (#14197). Achada depois do `---`
 * que fechou um destaque, antes do próximo header, sinaliza um `---` DENTRO do
 * destaque: o resto dele caiu no `pool`, e o plano parcial deixaria o destaque
 * sem recheck. Box de divulgação entre destaques não traz essas linhas.
 */
const DESTAQUE_BODY_MARKER_RE = /^(?:\*\*|_)?\s*(?:por que isso importa|aprofunde)\b/iu;
/**
 * Header de seção que fecha um bloco de destaque mesmo sem `---`: as seções do
 * pool pelo registro canônico (`SECTIONS` de `section-naming.ts`, o mesmo do
 * stitch/render) mais as seções fixas depois dos destaques (É IA?, ERRO
 * INTENCIONAL).
 */
const SECTION_HEADER_RE = sectionHeaderRegex(
  String.raw`${ALL_SECTION_NAMES_PATTERN}|[ÉE]\s+IA\?|ERRO\s+INTENCIONAL`,
  { capture: "none", flags: "u" },
);

/** Unidade de um claim: `d{N}` para destaque numérico, `pool` para `"secondary"`. */
export function claimUnit(destaque: number | "secondary"): string {
  return destaque === "secondary" ? POOL_UNIT : `d${destaque}`;
}

/** Ordem de exibição: d1, d2, d3, ..., pool. */
export function unitRank(unit: string): number {
  const m = /^d(\d+)$/.exec(unit);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

export function sortUnits(units: Iterable<string>): string[] {
  return [...new Set(units)].sort((a, b) => unitRank(a) - unitRank(b) || a.localeCompare(b));
}

/**
 * Parte a newsletter em `d{N}` e `pool` (todo o resto). Concatenar as partes
 * devolve todas as linhas: nenhuma mudança escapa de alguma unidade.
 */
export function splitNewsletterUnits(md: string): Record<string, string> {
  return partitionNewsletter(md).units;
}

/**
 * Partição com diagnóstico. O bloco de destaque fecha no `---`, no header de
 * outro destaque ou num header de seção conhecido (LANÇAMENTOS, RADAR, USE
 * MELHOR, VÍDEOS, É IA?, ERRO INTENCIONAL). `ambiguous` quando o fim não é
 * claro (bloco que vai até o fim do arquivo, o mesmo `DESTAQUE N` duas vezes,
 * ou texto de destaque — "Por que isso importa", "Aprofunde" — depois do `---`
 * que fechou o bloco, antes do próximo header, #14197): aí o plano sai
 * completo. A partição em si não muda: o `---` segue fechando o bloco, para o
 * box entre destaques continuar no `pool`.
 */
export function partitionNewsletter(md: string): { units: Record<string, string>; ambiguous?: string } {
  const out: Record<string, string[]> = { [POOL_UNIT]: [] };
  const seen = new Set<string>();
  const problems: string[] = [];
  let current: string | null = null;
  /** Destaque fechado por `---` cujo próximo header ainda não veio (#14197). */
  let closedBySeparator: string | null = null;
  const flaggedSeparator = new Set<string>();
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    const t = line.trim();
    const header = DESTAQUE_HEADER_RE.exec(t);
    if (header) {
      current = `d${Number(header[1])}`;
      closedBySeparator = null;
      if (seen.has(current)) problems.push(`header DESTAQUE ${header[1]} repetido`);
      seen.add(current);
    } else if (SECTION_HEADER_RE.test(t)) {
      current = null;
      closedBySeparator = null;
    } else if (current && SEPARATOR_RE.test(t)) {
      closedBySeparator = current;
      current = null;
    } else if (!current && closedBySeparator && DESTAQUE_BODY_MARKER_RE.test(t)) {
      if (!flaggedSeparator.has(closedBySeparator)) {
        flaggedSeparator.add(closedBySeparator);
        problems.push(`\`---\` dentro de ${closedBySeparator}: texto de destaque depois do separador`);
      }
    }
    const key = current ?? POOL_UNIT;
    (out[key] ??= []).push(line);
  }
  if (current) problems.push(`bloco ${current} sem fim (nem --- nem header de seção até o fim do arquivo)`);
  return {
    units: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join("\n")])),
    ...(problems.length > 0 ? { ambiguous: problems.join("; ") } : {}),
  };
}

const URL_IN_MD_RE = /https?:\/\/[^\s\]<>"()]+/g;

function urlKeyOf(url: string): string {
  try {
    return canonicalize(url);
  } catch {
    return url;
  }
}

/** Fingerprint das fontes lidas dos itens cujas URLs aparecem no texto do pool. */
function poolSourceFingerprint(poolText: string, src: UnitSourceInputs): string[] {
  const byKey = new Map<string, PoolSourceFingerprint>();
  for (const e of src.poolSources ?? []) byKey.set(urlKeyOf(e.url), e);
  const keys = [
    ...new Set([...poolText.matchAll(URL_IN_MD_RE)].map((m) => urlKeyOf(m[0].replace(/[*.,;:]+$/, "")))),
  ].sort();
  return keys.map((k) => {
    const e = byKey.get(k);
    return e ? `${k}|${e.status ?? ""}|${e.completeness ?? ""}|${e.textHash ?? ""}` : `${k}|sem-fonte`;
  });
}

/**
 * Parte o social: `## d{N}` e `## d{N}-cards` (em qualquer `# …`, inclusive
 * `# Curto`) vão para `d{N}`; `## um` vai para `pool`; o resto (preâmbulo,
 * headers `#`, seção desconhecida) vai para `global`.
 */
export function splitSocialUnits(md: string): { units: Record<string, string>; global: string } {
  const units: Record<string, string[]> = {};
  const global: string[] = [];
  let current: string | null = null;
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    const t = line.trim();
    if (/^#\s/.test(t)) {
      current = null;
    } else if (/^##\s/.test(t)) {
      const id = t.replace(/^##\s+/, "").trim().toLowerCase();
      const d = /^d(\d+)(?:-cards)?$/.exec(id);
      current = d ? `d${Number(d[1])}` : id === "um" ? POOL_UNIT : null;
    }
    if (current) (units[current] ??= []).push(line);
    else global.push(line);
  }
  return {
    units: Object.fromEntries(Object.entries(units).map(([k, v]) => [k, v.join("\n")])),
    global: global.join("\n"),
  };
}

function sourceFingerprint(n: number, src: UnitSourceInputs): string[] {
  const fp = (e: UnitSourceEntry) => `${e.url}|${e.status ?? ""}|${e.completeness ?? ""}|${e.textHash ?? ""}`;
  return [
    `approved:${src.approvedUrls[n - 1] ?? ""}`,
    ...src.manifest.filter((e) => e.destaque === n).map((e) => `manifest:${fp(e)}`),
    ...src.extras
      .filter((e) => e.destaque === n)
      .sort((a, b) => (a.k ?? 0) - (b.k ?? 0))
      .map((e) => `extra:${fp(e)}`),
  ];
}

/** Hash por unidade do conteúdo atual (texto + fontes de cada destaque). */
export function computeUnitHashes(
  newsletterMd: string | null | undefined,
  socialMd: string | null | undefined,
  src: UnitSourceInputs,
): FactCheckUnitHashes {
  const part = partitionNewsletter(newsletterMd ?? "");
  const nl = part.units;
  const so = splitSocialUnits(socialMd ?? "");
  const destaques = new Set<number>();
  for (const k of [...Object.keys(nl), ...Object.keys(so.units)]) {
    const m = /^d(\d+)$/.exec(k);
    if (m) destaques.add(Number(m[1]));
  }
  src.approvedUrls.forEach((u, i) => {
    if (u) destaques.add(i + 1);
  });
  const units: Record<string, string> = {};
  for (const n of [...destaques].sort((a, b) => a - b)) {
    const key = `d${n}`;
    units[key] = hashContent(
      JSON.stringify({ newsletter: nl[key] ?? null, social: so.units[key] ?? null, sources: sourceFingerprint(n, src) }),
    );
  }
  units[POOL_UNIT] = hashContent(
    JSON.stringify({
      newsletter: nl[POOL_UNIT] ?? "",
      social: so.units[POOL_UNIT] ?? null,
      sources: poolSourceFingerprint(`${nl[POOL_UNIT] ?? ""}\n${so.units[POOL_UNIT] ?? ""}`, src),
    }),
  );
  return { units, global: hashContent(so.global), ...(part.ambiguous ? { ambiguous: part.ambiguous } : {}) };
}

/** Valida o shape vindo do JSON (unknown → carimbo ou undefined). */
export function parseUnitHashes(raw: unknown): FactCheckUnitHashes | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.global !== "string" || !o.units || typeof o.units !== "object") return undefined;
  const units: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.units as Record<string, unknown>)) {
    if (typeof v !== "string") return undefined;
    units[k] = v;
  }
  if (!(POOL_UNIT in units)) return undefined;
  return { units, global: o.global };
}

/** Mesmo conjunto de unidades, mesmo hash em cada uma e no `global`. */
export function sameUnitHashes(a: FactCheckUnitHashes, b: FactCheckUnitHashes): boolean {
  const ka = sortUnits(Object.keys(a.units));
  const kb = sortUnits(Object.keys(b.units));
  return a.global === b.global && ka.join(",") === kb.join(",") && ka.every((k) => a.units[k] === b.units[k]);
}

export type FactCheckScopeMode = "full" | "partial" | "none";

export interface FactCheckScope {
  mode: FactCheckScopeMode;
  /** Unidades a despachar (`partial`); vazio em `full`/`none`. */
  units: string[];
  /** Unidades reaproveitadas do fact-check anterior (`partial`/`none`). */
  reused: string[];
  reason: string;
}

/**
 * Decide o escopo do re-run. `full` sempre que não dá pra garantir o recorte:
 * sem fact-check anterior, carimbo por unidade ausente (fact-check anterior ao
 * #14035), parte `global` do social mudou, ou o conjunto de destaques mudou.
 */
export function planFactCheckScope(
  stamp: FactCheckUnitHashes | undefined,
  current: FactCheckUnitHashes,
  opts: { hasPreviousResult: boolean; forceFull?: boolean },
): FactCheckScope {
  const all = sortUnits(Object.keys(current.units));
  const full = (reason: string): FactCheckScope => ({ mode: "full", units: [], reused: [], reason });
  if (opts.forceFull) return full("--full pedido");
  if (!opts.hasPreviousResult) return full("sem fact-check.json anterior legível");
  if (current.ambiguous) return full(`partição ambígua: ${current.ambiguous}`);
  if (!stamp) return full("fact-check.json sem carimbo por unidade (anterior ao #14035)");
  if (stamp.global !== current.global) return full("03-social.md mudou fora das seções d{N}/um");
  const before = sortUnits(Object.keys(stamp.units));
  if (before.join(",") !== all.join(",")) {
    return full(`conjunto de unidades mudou (${before.join(", ")} → ${all.join(", ")})`);
  }
  const changed = all.filter((u) => stamp.units[u] !== current.units[u]);
  const reused = all.filter((u) => !changed.includes(u));
  if (changed.length === 0) {
    return { mode: "none", units: [], reused, reason: "nenhuma unidade mudou desde a última checagem" };
  }
  return { mode: "partial", units: changed, reused, reason: `mudou: ${changed.join(", ")}` };
}

/**
 * Junta o resultado parcial com o anterior: claims das unidades rechecadas
 * vêm SÓ do parcial (nenhum veredito velho de unidade mudada sobrevive);
 * claims das demais vêm do anterior. Claim do parcial fora do escopo é
 * descartado e devolvido em `outOfScope` (o anterior daquela unidade vale).
 */
export function mergePartialClaims<T extends { destaque: number | "secondary" }>(
  previous: T[],
  partial: T[],
  units: string[],
): { claims: T[]; outOfScope: T[] } {
  const scope = new Set(units);
  const kept = previous.filter((c) => !scope.has(claimUnit(c.destaque)));
  const fresh = partial.filter((c) => scope.has(claimUnit(c.destaque)));
  const outOfScope = partial.filter((c) => !scope.has(claimUnit(c.destaque)));
  const indexed = [...kept, ...fresh].map((c, i) => ({ c, i }));
  indexed.sort((a, b) => unitRank(claimUnit(a.c.destaque)) - unitRank(claimUnit(b.c.destaque)) || a.i - b.i);
  return { claims: indexed.map((x) => x.c), outOfScope };
}

/**
 * Confere que o parcial cobre o plano antes do merge (#14035). Devolve os
 * problemas (vazio = ok). Recusa quando:
 *   - o agente não ecoou `units` ou ecoou outra lista (dispatch com lista velha);
 *   - um `d{N}` do plano não tem o claim `headline` (obrigatório por destaque,
 *     #9383) — sinal de saída truncada ou de unidade não checada;
 *   - há claim fora do escopo (o agente checou o que não devia; o veredito
 *     dele não entra, e o anterior daquela unidade pode estar velho).
 * O merge sem essa checagem apagaria os claims antigos da unidade e a
 * carimbaria como checada sem checagem nenhuma.
 */
export function partialCoverageProblems(
  planUnits: string[],
  echoedUnits: unknown,
  partialClaims: Array<{ destaque: number | "secondary"; claim_type?: string }>,
): string[] {
  const problems: string[] = [];
  const plan = sortUnits(planUnits);
  if (!Array.isArray(echoedUnits) || !echoedUnits.every((u) => typeof u === "string")) {
    problems.push(`parcial sem \`units\` ecoado (plano: ${plan.join(", ")})`);
  } else {
    const echoed = sortUnits(echoedUnits as string[]);
    if (echoed.join(",") !== plan.join(",")) {
      problems.push(`\`units\` do parcial (${echoed.join(", ") || "vazio"}) não bate com o plano (${plan.join(", ")})`);
    }
  }
  const missingHeadline = plan.filter(
    (u) => /^d\d+$/.test(u) && !partialClaims.some((c) => claimUnit(c.destaque) === u && c.claim_type === "headline"),
  );
  if (missingHeadline.length > 0) {
    problems.push(`sem claim \`headline\` (obrigatório por destaque, #9383) em ${missingHeadline.join(", ")}`);
  }
  const scope = new Set(plan);
  const outOfScope = sortUnits(partialClaims.map((c) => claimUnit(c.destaque)).filter((u) => !scope.has(u)));
  if (outOfScope.length > 0) {
    const n = partialClaims.filter((c) => !scope.has(claimUnit(c.destaque))).length;
    problems.push(`${n} claim(s) fora do escopo (${outOfScope.join(", ")})`);
  }
  return problems;
}

function readJsonArray(path: string): UnitSourceEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as UnitSourceEntry[]).filter((e) => e && typeof e.destaque === "number") : [];
  } catch {
    return [];
  }
}

/** Hash do texto de um arquivo de fonte; `null` se ausente/ilegível. */
function fileTextHash(path: string): string | null {
  try {
    return hashContent(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Lê do disco as fontes que entram no hash de cada destaque: URLs do
 * `01-approved.json`, `fact-check-sources/manifest.json` e `extras.json`, com o
 * hash do texto baixado de cada uma (`d{N}.txt`, `d{N}-extra-{k}.txt`) — texto
 * que muda sem o status mudar também recheca o destaque.
 * Fail-soft: arquivo ausente/ilegível vira lista vazia (o hash muda, o que só
 * pode levar a rechecar mais, nunca menos).
 */
export function readUnitSourceInputs(internalDir: string): UnitSourceInputs {
  let approvedUrls: Array<string | undefined> = [];
  try {
    const approved = JSON.parse(readFileSync(join(internalDir, "01-approved.json"), "utf8")) as {
      highlights?: Array<{ url?: string; article?: { url?: string } }>;
    };
    const hl = approved?.highlights ?? [];
    approvedUrls = Array.from({ length: Math.min(hl.length, 3) }, (_, i) => hl[i]?.url ?? hl[i]?.article?.url);
  } catch {
    approvedUrls = [];
  }
  const sourcesDir = join(internalDir, "fact-check-sources");
  const poolDir = join(internalDir, POOL_SOURCES_DIR);
  const poolSources: PoolSourceFingerprint[] = readPoolSourcesManifest(internalDir).map((e) => ({
    url: e.url,
    status: e.status,
    completeness: e.completeness,
    textHash: e.file ? fileTextHash(join(poolDir, e.file)) : null,
  }));
  const manifest = readJsonArray(join(sourcesDir, "manifest.json")).map((e) => ({
    ...e,
    textHash: fileTextHash(join(sourcesDir, `d${e.destaque}.txt`)),
  }));
  const extras = readExtrasManifest(sourcesDir).map((e) => ({
    ...e,
    textHash: typeof e.k === "number" ? fileTextHash(join(sourcesDir, extraSourceFileName(e.destaque, e.k))) : null,
  }));
  return { approvedUrls, manifest, extras, poolSources };
}

export const SCOPE_FILE = "fact-check-scope.json";
export const PARTIAL_FILE = "fact-check.partial.json";

/** `_internal/fact-check-scope.json`: o plano gravado no passo 1 do §4c.6. */
export interface FactCheckScopeFile extends FactCheckScope {
  planned_at: string;
  /** Carimbos do conteúdo no momento do plano — o merge carimba com eles. */
  unit_hashes: FactCheckUnitHashes;
  content_hash: { newsletter: string | null; social: string | null };
}
