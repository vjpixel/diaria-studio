#!/usr/bin/env tsx
/**
 * select-boxes-by-clicks.ts (#4626)
 *
 * Seleção AUTOMÁTICA de qual box de divulgação (`context/snippets/*.md`)
 * ocupa cada slot de rotação (1, 2, 3 — gaps D1/D2, D2/D3 e pós-último-
 * destaque) de uma edição, substituindo a escolha estática manual em
 * `platform.config.json` → `boxes_divulgacao` quando `boxes_divulgacao_auto.enabled`
 * é `true`. Decisão do editor (#4626, comentários 260805b/260806): seleção
 * 100% automática, SEM gate — a troca de box é CTA de divulgação, não
 * conteúdo editorial, mesmo racional do Stage 5 (#1326/#1694). O override do
 * editor, quando ele discordar, acontece no gate do Stage 4 editando
 * `02-reviewed.md` diretamente (mesmo mecanismo já usado pra qualquer outra
 * correção pontual do gate) — não uma tela de confirmação nova.
 *
 * **Reuso, não duplicação:** toda a lógica de MATCH (qual snippet corresponde
 * a qual box, por URL) e de SOMA de cliques (`sumClicksForUrl`) vem de
 * `box-click-report.ts` (#4354) — importada aqui, não reimplementada. Este
 * módulo adiciona só o que `box-click-report.ts` deliberadamente NÃO
 * mantém: granularidade POR EDIÇÃO (`buildSnippetHistory`, necessária pra
 * calcular tendência) e a lógica de SELEÇÃO em si (ranking + tendência +
 * anti-repetição + resolução por slot).
 *
 * **Escopo: só os slots 1/2/3 (rotação D1/D2, D2/D3, pós-último-destaque).**
 * Slot 0 (introdução) fica de fora por decisão editorial preexistente e
 * distinta (#4274: "5 slots preenchidos seria demais numa edição de leitura
 * de 5 minutos" — default `null`/opt-in raro, não um slot de rotação) — não
 * é a mesma coisa que a exceção do bloco WhatsApp (que nem é um snippet de
 * `context/snippets/`, então estruturalmente nunca poderia entrar neste
 * ranking de qualquer forma).
 *
 * **Precedência config vs. automação (decisão desta unidade, documentada no
 * PR #4626):**
 *   - `boxes_divulgacao_auto.enabled !== true` (ausente ou `false`) — a
 *     automação fica DESLIGADA por completo; `boxes_divulgacao.slot{1,2,3}`
 *     valem exatamente como hoje (comportamento 100% pré-#4626, nenhuma
 *     mudança). Este é o default quando a chave não existe — back-compat
 *     total com qualquer config/teste que não conhece esta feature.
 *   - `enabled: true` e o slot está listado em `pinned_slots` — MANUAL: o
 *     editor pinou esse slot explicitamente; o valor de
 *     `boxes_divulgacao.slot{N}` é usado tal como está, sem entrar no
 *     ranking nem na checagem de anti-repetição. Pin do editor sempre vence.
 *   - `enabled: true` e o slot NÃO está em `pinned_slots` — AUTOMÁTICO: a
 *     seleção roda (critério 1: ranking por cliques; critério 2: penalidade
 *     de tendência de queda; critério 3: nunca repetir a box da edição
 *     imediatamente anterior) e o resultado SUBSTITUI, só em memória (nunca
 *     grava em `platform.config.json`), o valor efetivo daquele slot pra
 *     esta stitch. O painel "Caixas" do Studio continua mostrando o valor
 *     PINADO/fallback do config — o valor de fato aplicado na edição do dia
 *     fica registrado em `_internal/box-selection.json` (consumido pelo
 *     resumo do Stage 4, §4c.7 de `orchestrator-stage-4.md`).
 *   - Sem candidato elegível pro slot (dado histórico insuficiente — edição
 *     muito nova / poucas edições no histórico —, ou todos os candidatos
 *     excluídos pela anti-repetição): CEDE pro valor JÁ CONFIGURADO em
 *     `boxes_divulgacao.slot{N}` (idêntico ao comportamento pré-#4626) —
 *     nunca esvazia o slot nem quebra a stitch por falta de dado.
 *
 * Uso standalone (debug/inspeção — a integração real acontece via import de
 * `resolveBoxesForEdition` por `scripts/stitch-newsletter.ts`):
 *   npx tsx scripts/select-boxes-by-clicks.ts --edition AAMMDD [--last N]
 *
 * Exit codes: 0 = sucesso (mesmo com 0 candidatos elegíveis — informativo,
 * nunca bloqueia), 1 = `data/editions` ausente, 2 = args inválidos.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { listEditions } from "./lib/edition-utils.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import {
  DEFAULT_LAST_N,
  extractEditionBoxUsages,
  findPostForEdition,
  isPostNeverEnriched, // #5153
  loadSnippets,
  sumClicksForUrl,
  type BoxSlot,
  type PostCacheLike,
  type SnippetInfo,
} from "./box-click-report.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDITIONS_DIR = resolve(ROOT, "data/editions");
const POSTS_DIR = resolve(ROOT, "data/beehiiv-cache/posts");
const SNIPPETS_DIR = resolve(ROOT, "context/snippets");
const CONFIG_PATH = resolve(ROOT, "platform.config.json");

/** #4626: só slot 1/2/3 entram na rotação automática — ver docstring do
 * módulo pro porquê do slot 0 ficar de fora. */
export const ROTATION_SLOTS: ReadonlySet<BoxSlot> = new Set<BoxSlot>([1, 2, 3]);

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ── Histórico por edição (pure, dado I/O injetado) ─────────────────────────

export interface SnippetEditionClicks {
  aammdd: string;
  unique_verified_clicks: number;
  verified_clicks: number;
}

export interface SnippetHistory {
  file: string;
  nome: string;
  /** Ordenado do mais ANTIGO pro mais NOVO — convenção que `computeTrend`
   * espera (janela "recente" = final do array). */
  appearances: SnippetEditionClicks[];
}

export interface BuildHistoryOpts {
  /** AAMMDD mais recentes primeiro (mesma convenção de `listEditions`). */
  aammddList: string[];
  readReviewedMd: (aammdd: string) => string | null;
  snippets: SnippetInfo[];
  findPost: (aammdd: string) => PostCacheLike | null;
  rotationSlots?: ReadonlySet<BoxSlot>;
}

/**
 * Constrói, por snippet, a série cronológica de cliques nas edições em que
 * ele de fato apareceu num slot de rotação (1/2/3). Diferente de
 * `buildBoxClickReport` (box-click-report.ts), que agrega tudo numa média —
 * aqui a granularidade por edição é preservada porque `computeTrend` precisa
 * dela.
 *
 * Uma edição SEM post Beehiiv cacheado (`findPost` retorna `null`) é
 * OMITIDA da série do snippet usado naquela edição — nunca vira uma
 * aparição com 0 cliques. Fabricar um zero aqui pareceria uma queda de
 * performance real quando na verdade é só ausência de dado (cache
 * incompleto / edição ainda não sincronizada) — mesmo tratamento
 * conservador que `buildBoxClickReport` já dá a esse caso (loga como
 * `unmatchedBoxes`, não conta como 0).
 *
 * **#5153: o mesmo vale pra post `never_enriched`** (fora da janela de 7
 * dias — `MIN_AGE_DAYS_FOR_CLICKS`, `scripts/lib/shared/ctr-config.ts` —,
 * enrichment ainda não rodou). `stats.clicks` vem `[]` nesse caso, mas isso
 * é dado AUSENTE, não zero medido — sem este guard, as edições mais RECENTES
 * (as que mais pesam na janela "recente" de `computeTrend`) entrariam como
 * aparições fabricadas de 0 cliques, derrubando artificialmente o score de
 * QUALQUER box que caísse nelas — achado ao vivo #5153, 260812.
 */
export function buildSnippetHistory(opts: BuildHistoryOpts): Map<string, SnippetHistory> {
  const rotationSlots = opts.rotationSlots ?? ROTATION_SLOTS;
  const acc = new Map<string, SnippetHistory>();
  // aammddList vem mais-recente-primeiro; percorrer invertido já popula
  // `appearances` da mais antiga pra mais nova (ordem que computeTrend espera).
  const chronological = [...opts.aammddList].reverse();
  for (const aammdd of chronological) {
    const md = opts.readReviewedMd(aammdd);
    if (!md) continue;
    const usages = extractEditionBoxUsages(md, opts.snippets).filter((u) => rotationSlots.has(u.slot));
    if (usages.length === 0) continue;
    const post = opts.findPost(aammdd);
    if (!post) continue; // sem dado de clique pra esta edição — não conta como aparição mensurável
    if (isPostNeverEnriched(post)) continue; // #5153: fora da janela de 7 dias — idem, não conta como aparição mensurável
    for (const usage of usages) {
      if (!usage.url || !usage.snippet) continue;
      const clicks = sumClicksForUrl(usage.url, post.stats?.clicks ?? []);
      const key = usage.snippet.file;
      const entry = acc.get(key) ?? { file: key, nome: usage.snippet.nome, appearances: [] as SnippetEditionClicks[] };
      entry.appearances.push({
        aammdd,
        unique_verified_clicks: clicks.unique_verified_clicks,
        verified_clicks: clicks.verified_clicks,
      });
      acc.set(key, entry);
    }
  }
  return acc;
}

// ── Tendência (critério 2) ─────────────────────────────────────────────────

export interface TrendResult {
  recentAvg: number;
  priorAvg: number;
  delta: number;
  declining: boolean;
  recentSampleSize: number;
  priorSampleSize: number;
}

/**
 * #4626 critério 2: tendência por janela comparativa — últimas `recentWindow`
 * APARIÇÕES da box (não edições no calendário, já que a box só existe nas
 * edições em que foi de fato escolhida) vs. as `priorWindow` aparições
 * imediatamente anteriores a essas. `null` quando não há aparições
 * suficientes em AMBAS as janelas pra julgar tendência (box nova, ou usada
 * só 1-2 vezes no histórico varrido) — `scoreBox` cai pro critério 1 (média
 * histórica simples) nesse caso, sem penalidade.
 */
export function computeTrend(
  appearancesOldestFirst: SnippetEditionClicks[],
  recentWindow = 3,
  priorWindow = 3,
): TrendResult | null {
  const n = appearancesOldestFirst.length;
  const recent = appearancesOldestFirst.slice(Math.max(0, n - recentWindow));
  const priorEnd = n - recentWindow;
  const prior = priorEnd > 0 ? appearancesOldestFirst.slice(Math.max(0, priorEnd - priorWindow), priorEnd) : [];
  if (recent.length === 0 || prior.length === 0) return null;
  const recentAvg = avg(recent.map((a) => a.unique_verified_clicks));
  const priorAvg = avg(prior.map((a) => a.unique_verified_clicks));
  return {
    recentAvg,
    priorAvg,
    delta: recentAvg - priorAvg,
    declining: recentAvg < priorAvg,
    recentSampleSize: recent.length,
    priorSampleSize: prior.length,
  };
}

// ── Ranking (critério 1 + 2 combinados) ────────────────────────────────────

export interface RankedBox {
  file: string;
  nome: string;
  editionsAppeared: number;
  avgUniqueVerifiedClicks: number;
  trend: TrendResult | null;
  /** Score final usado pra ordenar candidatos — igual à média histórica na
   * maioria dos casos; quando `trend.declining` é `true`, cai pra
   * `trend.recentAvg` (mais baixa) em vez da média histórica inflada. */
  score: number;
}

/**
 * #4626 critério 1+2: combina o ranking por cliques (média histórica) com a
 * penalidade de tendência de queda. Uma box com média histórica alta mas em
 * queda recente tem seu score REBAIXADO pra refletir a média RECENTE (mais
 * baixa) em vez da histórica — "cede espaço" a boxes estáveis ou em alta
 * mesmo com average nominal maior, satisfazendo o critério 2 da issue
 * literalmente.
 */
export function scoreBox(history: SnippetHistory, recentWindow = 3, priorWindow = 3): RankedBox {
  const clicks = history.appearances.map((a) => a.unique_verified_clicks);
  const avgAll = avg(clicks);
  const trend = computeTrend(history.appearances, recentWindow, priorWindow);
  const score = trend && trend.declining ? trend.recentAvg : avgAll;
  return {
    file: history.file,
    nome: history.nome,
    editionsAppeared: clicks.length,
    avgUniqueVerifiedClicks: avgAll,
    trend,
    score,
  };
}

// ── Anti-repetição (critério 3) ─────────────────────────────────────────────

/**
 * #4626 critério 3: acha a 1ª edição LEGÍVEL (tem `02-reviewed.md`) na lista,
 * excluindo `currentAammdd` (a própria edição em curso, que normalmente ainda
 * não tem `02-reviewed.md` neste ponto do Stage 2, mas é excluída
 * explicitamente por segurança) — e devolve o conjunto de arquivos de
 * snippet usados nos slots de rotação dessa edição. Esse é o conjunto que
 * NUNCA pode ser escolhido automaticamente pra esta edição, seja qual for o
 * slot (a regra da issue é "nenhuma box da edição anterior", não "nenhuma
 * box no MESMO slot da edição anterior").
 */
export function findPreviousEditionSnippets(
  currentAammdd: string,
  aammddListNewestFirst: string[],
  readReviewedMd: (aammdd: string) => string | null,
  snippets: SnippetInfo[],
  rotationSlots: ReadonlySet<BoxSlot> = ROTATION_SLOTS,
): Set<string> {
  for (const aammdd of aammddListNewestFirst) {
    if (aammdd === currentAammdd) continue;
    const md = readReviewedMd(aammdd);
    if (!md) continue;
    const usages = extractEditionBoxUsages(md, snippets).filter((u) => rotationSlots.has(u.slot) && u.snippet);
    return new Set(usages.map((u) => u.snippet!.file));
  }
  return new Set();
}

// ── Seleção por slot ────────────────────────────────────────────────────────

export type SlotNumber = 1 | 2 | 3;

export interface SlotPick {
  slot: SlotNumber;
  file: string | null;
  nome: string | null;
  score: number | null;
  trend: TrendResult | null;
  editionsAppeared: number | null;
}

export interface SelectSlotsOpts {
  /** Pool de candidatos — qualquer ordem, `selectBoxesForSlots` ordena
   * internamente por `score` desc (tiebreak alfabético por `file`, pra
   * determinismo em teste). */
  ranked: RankedBox[];
  slotsToFill: SlotNumber[];
  /** Arquivos banidos desta edição por anti-repetição (critério 3). */
  excludeFiles: ReadonlySet<string>;
  /** Arquivos já ocupados por slots PINADOS/fixos nesta mesma edição — nunca
   * escolhidos de novo pra outro slot (duplicaria a mesma divulgação 2x). */
  alreadyAssignedFiles?: ReadonlySet<string>;
}

/**
 * Escolhe, por slot, o candidato de maior score ainda disponível — greedy
 * por ordem de `slotsToFill` (slot 1 escolhe primeiro, depois 2, depois 3;
 * caller decide a ordem, tipicamente 1→2→3 espelhando a prioridade de
 * `assignDivulgacaoGaps`). Sem candidato disponível pro slot (pool
 * esgotado ou vazio) → `file: null` (caller decide o fallback — ver
 * `resolveBoxesForEdition`).
 */
export function selectBoxesForSlots(opts: SelectSlotsOpts): SlotPick[] {
  const excluded = new Set<string>([...opts.excludeFiles, ...(opts.alreadyAssignedFiles ?? [])]);
  const pool = opts.ranked
    .filter((r) => !excluded.has(r.file))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const used = new Set<string>();
  const picks: SlotPick[] = [];
  for (const slot of opts.slotsToFill) {
    const candidate = pool.find((r) => !used.has(r.file));
    if (!candidate) {
      picks.push({ slot, file: null, nome: null, score: null, trend: null, editionsAppeared: null });
      continue;
    }
    used.add(candidate.file);
    picks.push({
      slot,
      file: candidate.file,
      nome: candidate.nome,
      score: candidate.score,
      trend: candidate.trend,
      editionsAppeared: candidate.editionsAppeared,
    });
  }
  return picks;
}

// ── Config (boxes_divulgacao_auto) ──────────────────────────────────────────

export interface BoxesDivulgacaoAutoConfig {
  enabled: boolean;
  pinnedSlots: ReadonlySet<SlotNumber>;
  recentWindow: number;
  priorWindow: number;
  lastN: number;
}

const DEFAULT_AUTO_CONFIG: BoxesDivulgacaoAutoConfig = {
  enabled: false,
  pinnedSlots: new Set(),
  recentWindow: 3,
  priorWindow: 3,
  lastN: DEFAULT_LAST_N,
};

/**
 * Lê `platform.config.json` → `boxes_divulgacao_auto`. Ausente/corrompido/
 * malformado → `enabled: false` (automação DESLIGADA) — back-compat total,
 * nunca lança. `pinned_slots` filtra qualquer valor fora de 1/2/3 (defensivo
 * — slot 0 nunca é pinável aqui, não faz parte desta feature).
 */
export function loadBoxesDivulgacaoAutoConfig(configPath: string = CONFIG_PATH): BoxesDivulgacaoAutoConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    const cfg = raw?.boxes_divulgacao_auto;
    if (!cfg || typeof cfg !== "object") return DEFAULT_AUTO_CONFIG;
    const pinnedRaw = Array.isArray(cfg.pinned_slots) ? cfg.pinned_slots : [];
    const pinnedSlots = new Set<SlotNumber>(
      pinnedRaw.filter((n: unknown): n is SlotNumber => n === 1 || n === 2 || n === 3),
    );
    const recentWindow = Number.isFinite(cfg.recent_window) && cfg.recent_window > 0 ? cfg.recent_window : 3;
    const priorWindow = Number.isFinite(cfg.prior_window) && cfg.prior_window > 0 ? cfg.prior_window : 3;
    const lastN = Number.isFinite(cfg.last_n) && cfg.last_n > 0 ? cfg.last_n : DEFAULT_LAST_N;
    return { enabled: cfg.enabled === true, pinnedSlots, recentWindow, priorWindow, lastN };
  } catch {
    return DEFAULT_AUTO_CONFIG;
  }
}

// ── Resolução end-to-end pra uma edição (impuro — disco) ────────────────────

/** Shape mínimo compatível com `BoxesDivulgacaoConfig` de stitch-newsletter.ts
 * — declarado localmente (em vez de importado) pra não criar dependência
 * circular entre os dois módulos (stitch-newsletter.ts importa deste
 * arquivo). Estruturalmente idêntico, TS aceita um no lugar do outro. */
export interface BoxesDivulgacaoConfigLike {
  slot0?: string | null;
  slot1: string | null;
  slot2: string | null;
  slot3?: string | null;
}

export interface ResolvedBoxes {
  slot0: string | null;
  slot1: string | null;
  slot2: string | null;
  slot3: string | null;
}

export interface SlotSelectionRecord {
  slot: SlotNumber;
  mode: "disabled" | "pinned" | "auto" | "fallback-no-candidates";
  file: string | null;
  nome: string | null;
  score: number | null;
  trend: TrendResult | null;
  editionsAppeared: number | null;
}

export interface ResolveBoxesOpts {
  aammdd: string;
  boxesCfg: BoxesDivulgacaoConfigLike;
  autoCfg?: BoxesDivulgacaoAutoConfig;
  editionsDir?: string;
  postsDir?: string;
  snippetsDir?: string;
}

export interface ResolveBoxesResult {
  effective: ResolvedBoxes;
  selection: SlotSelectionRecord[];
}

function loadPostsCache(postsDir: string): PostCacheLike[] {
  if (!existsSync(postsDir)) return [];
  return readdirSync(postsDir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(postsDir, f), "utf8")) as PostCacheLike;
      } catch {
        return null;
      }
    })
    .filter((p): p is PostCacheLike => p !== null);
}

const SLOT_KEY: Record<SlotNumber, "slot1" | "slot2" | "slot3"> = { 1: "slot1", 2: "slot2", 3: "slot3" };

/**
 * Ponto de entrada usado por `scripts/stitch-newsletter.ts` (Stage 2) —
 * resolve, pra uma edição específica, o mapeamento efetivo slot→snippet
 * (aplicando a precedência documentada no topo do módulo) e o registro de
 * seleção pra visibilidade no Stage 4. NUNCA escreve em
 * `platform.config.json` — a mudança é só em memória pra esta stitch;
 * `boxes_divulgacao` no disco permanece o valor pinado/fallback.
 *
 * Fail-soft por construção: qualquer slot sem candidato elegível (dado
 * histórico ausente/insuficiente, ou anti-repetição esgotando o pool) cai no
 * valor já configurado — o pior caso é idêntico ao comportamento pré-#4626,
 * nunca uma stitch quebrada ou um slot vazio por falta de dado.
 */
export function resolveBoxesForEdition(opts: ResolveBoxesOpts): ResolveBoxesResult {
  const autoCfg = opts.autoCfg ?? loadBoxesDivulgacaoAutoConfig();
  const effective: ResolvedBoxes = {
    slot0: opts.boxesCfg.slot0 ?? null,
    slot1: opts.boxesCfg.slot1 ?? null,
    slot2: opts.boxesCfg.slot2 ?? null,
    slot3: opts.boxesCfg.slot3 ?? null,
  };

  if (!autoCfg.enabled) {
    const selection: SlotSelectionRecord[] = ([1, 2, 3] as const).map((slot) => ({
      slot,
      mode: "disabled",
      file: effective[SLOT_KEY[slot]],
      nome: null,
      score: null,
      trend: null,
      editionsAppeared: null,
    }));
    return { effective, selection };
  }

  const editionsDir = opts.editionsDir ?? EDITIONS_DIR;
  const postsDir = opts.postsDir ?? POSTS_DIR;
  const snippets = loadSnippets(opts.snippetsDir ?? SNIPPETS_DIR);
  const posts = loadPostsCache(postsDir);
  const dirsByAammdd = enumerateEditionDirs(editionsDir);
  const aammddList = listEditions(editionsDir).slice(0, autoCfg.lastN);

  const readReviewedMd = (aammdd: string): string | null => {
    const dir = dirsByAammdd.get(aammdd);
    if (!dir) return null;
    const path = join(dir, "02-reviewed.md");
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };

  const history = buildSnippetHistory({
    aammddList,
    readReviewedMd,
    snippets,
    findPost: (aammdd) => findPostForEdition(aammdd, posts),
  });
  const ranked = [...history.values()].map((h) => scoreBox(h, autoCfg.recentWindow, autoCfg.priorWindow));
  const previousSnippets = findPreviousEditionSnippets(opts.aammdd, aammddList, readReviewedMd, snippets);

  const slotsToAuto = ([1, 2, 3] as const).filter((s) => !autoCfg.pinnedSlots.has(s));
  const alreadyAssignedFiles = new Set<string>();
  for (const s of [1, 2, 3] as const) {
    if (autoCfg.pinnedSlots.has(s) && effective[SLOT_KEY[s]]) {
      alreadyAssignedFiles.add(effective[SLOT_KEY[s]]!);
    }
  }
  if (effective.slot0) alreadyAssignedFiles.add(effective.slot0);

  const picks = selectBoxesForSlots({
    ranked,
    slotsToFill: slotsToAuto,
    excludeFiles: previousSnippets,
    alreadyAssignedFiles,
  });
  const pickBySlot = new Map(picks.map((p) => [p.slot, p]));

  const selection: SlotSelectionRecord[] = [];
  for (const slot of [1, 2, 3] as const) {
    if (autoCfg.pinnedSlots.has(slot)) {
      selection.push({
        slot,
        mode: "pinned",
        file: effective[SLOT_KEY[slot]],
        nome: null,
        score: null,
        trend: null,
        editionsAppeared: null,
      });
      continue;
    }
    const pick = pickBySlot.get(slot);
    if (pick && pick.file) {
      effective[SLOT_KEY[slot]] = pick.file;
      selection.push({
        slot,
        mode: "auto",
        file: pick.file,
        nome: pick.nome,
        score: pick.score,
        trend: pick.trend,
        editionsAppeared: pick.editionsAppeared,
      });
    } else {
      selection.push({
        slot,
        mode: "fallback-no-candidates",
        file: effective[SLOT_KEY[slot]],
        nome: null,
        score: null,
        trend: null,
        editionsAppeared: null,
      });
    }
  }

  return { effective, selection };
}

// ── CLI (debug/inspeção standalone) ─────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  const editionIdx = argv.indexOf("--edition");
  const edition = editionIdx !== -1 ? argv[editionIdx + 1] : undefined;
  const lastIdx = argv.indexOf("--last");
  const lastN = lastIdx !== -1 && argv[lastIdx + 1] ? Number(argv[lastIdx + 1]) : undefined;

  if (!edition || !/^\d{6}$/.test(edition)) {
    console.error("uso: select-boxes-by-clicks.ts --edition AAMMDD [--last N]");
    process.exit(2);
  }

  if (!existsSync(EDITIONS_DIR)) {
    console.error(
      `[select-boxes-by-clicks] ${EDITIONS_DIR} não encontrado — data/ ausente (junction OneDrive não criada nesta máquina?)`,
    );
    process.exit(1);
  }

  let boxesCfg: BoxesDivulgacaoConfigLike = { slot0: null, slot1: null, slot2: null, slot3: null };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (raw.boxes_divulgacao && typeof raw.boxes_divulgacao === "object") {
      boxesCfg = {
        slot0: raw.boxes_divulgacao.slot0 ?? null,
        slot1: raw.boxes_divulgacao.slot1 ?? null,
        slot2: raw.boxes_divulgacao.slot2 ?? null,
        slot3: raw.boxes_divulgacao.slot3 ?? null,
      };
    }
  } catch {
    // graceful — segue com boxesCfg vazio
  }

  const autoCfg = loadBoxesDivulgacaoAutoConfig();
  const result = resolveBoxesForEdition({
    aammdd: edition,
    boxesCfg,
    autoCfg: lastN && lastN > 0 ? { ...autoCfg, lastN } : autoCfg,
  });

  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
