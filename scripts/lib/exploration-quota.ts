/**
 * exploration-quota.ts (#8370, Peça 2)
 *
 * Cota SEMANAL de exploração no scorer — epsilon-greedy manual sobre a
 * seleção de destaques.
 *
 * ## O problema (#8370)
 *
 * Os três sinais que o scorer usa são ENDÓGENOS: formulário (`surveyTools`),
 * CTR por categoria (`data/link-ctr-table.csv`) e as 49 fontes cadastradas —
 * todos derivam de escolhas nossas anteriores. Item nunca exibido tem CTR
 * indefinido, não zero, mas na prática cai na faixa de afinidade baixa e é
 * preterido. Medido no acervo: big-tech/lab foi de 26% dos destaques
 * (nov/2025) para 67% (set/2026), e a fatia brasileira caiu de 12-14% para 2%.
 *
 * ## O mecanismo
 *
 * Generaliza o que o #2131 fez para UMA categoria ("não subponderar
 * Segurança"): reserva **N slots por SEMANA** (não por edição) para itens com
 * sinal exógeno — `affinity < EXPLORATION_AFFINITY_MAX` mas score-base
 * competitivo (dentro de `scoreGapPts` do destaque mais fraco do dia), **e que
 * não seja big-tech** (piso de `isBigTechItem` — afinidade baixa sozinha não
 * distingue "nunca mostrado" de "mostrado todo dia"; ver a docstring dessa
 * função pro achado medido que a motivou). O item escolhido sai marcado
 * `exploracao: true`.
 *
 * **N = 4/semana** é decisão do editor registrada na #8370 (briefing da
 * rodada overnight 260918c: "N = 3-4 destaques/semana", opção mais agressiva
 * que a sugestão de partida de 2/semana, aceitando risco de CTR). Vive em
 * `platform.config.json` → `editorial_exploration.slots_per_week`, nunca
 * hardcoded no meio da lógica — o comentário da issue é explícito que o
 * número pode ser revisto pra baixo se o CTR de exploração cair.
 *
 * ## Por que a cota é semanal e precisa de estado
 *
 * Uma cota por edição não é expressável como "3-4 por semana" (daria 0 ou
 * 5-6). O estado atravessa edições e vive em `data/exploration-quota.json`
 * (`data/` já sincroniza entre as máquinas do projeto via OneDrive, #5227) —
 * mesmo padrão dos demais `*-store.ts`/`*-state.ts` de `scripts/lib/`, com a
 * mesma degradação graciosa quando `data/` está ausente (worktree isolado,
 * clone fresco, CI): a cota vira no-op com aviso, nunca lança.
 *
 * O registro é **por edição** (chave `AAMMDD`), não um contador incremental:
 * re-rodar o Stage 1 da mesma edição (resume, #6171) sobrescreve a entrada em
 * vez de consumir um slot novo. Idempotente por construção.
 *
 * ## Como a Peça 3 lê isso
 *
 * `scripts/measure-editorial-concentration.ts` (#8370 Peça 3, já em master)
 * agrega por SLUG de página do acervo e aceita `exploracaoFlags:
 * Map<slug, boolean>`. `explorationFlagsBySlug` faz esse join a partir do
 * `lastmodBySlug` que o próprio script já monta do `sitemap.xml` — a data
 * editorial da edição `AAMMDD` casa com o `<lastmod>` do slug. Nenhuma fonte
 * de dado nova é necessária dos dois lados.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { withFileLock } from "./file-lock.ts";
import { classifyItem } from "./editorial-concentration.ts"; // #8370 Peça 3 — mesma lista de termos

// ─── Config ────────────────────────────────────────────────────────────────

/**
 * Teto de afinidade que marca um item como "sinal exógeno". `0.1` é o mesmo
 * limiar que a #8370 cita como o ponto onde o item nunca exibido cai na
 * prática ("`affinity < 0.1 → −5`").
 */
export const EXPLORATION_AFFINITY_MAX = 0.1;

/** Decisão do editor (#8370, briefing 260918c): 3-4 destaques/semana. */
export const EXPLORATION_DEFAULT_SLOTS_PER_WEEK = 4;

/**
 * Quantos pontos abaixo do destaque mais fraco do dia um candidato ainda
 * conta como "score-base competitivo". Mesma ordem de grandeza do "~5 pts do
 * 6º colocado" que o #2131 usa pra Segurança em `scorer-select.md`, com
 * folga: o pool de destaques do dia costuma ficar dentro de uma dezena de
 * pontos.
 */
export const EXPLORATION_DEFAULT_SCORE_GAP_PTS = 8;

/**
 * Quantos dos highlights selecionados de fato viram destaque publicado. O
 * `scorer-select` entrega 6 candidatos; o editor poda pra 2-3 no gate do
 * Stage 1 (CLAUDE.md — "edição tem sempre 2 ou 3 destaques"). Promover um
 * item de exploração pro slot 5 seria cota de fachada: ele nunca chegaria ao
 * leitor. Por isso a troca acontece dentro dos 3 primeiros.
 */
export const EXPLORATION_DESTAQUE_SLOTS = 3;

/**
 * **Não existe teto configurável por edição, de propósito.** `applyExplorationQuota`
 * marca no MÁXIMO 1 destaque por edição, por construção (toda decisão retorna
 * assim que encontra o item) — um `max_per_edition: 2` em config não faria
 * nada, e um knob que não faz nada é pior que knob nenhum. Quem quiser mais
 * exploração sobe `slots_per_week`: a cota é semanal, é essa a unidade que o
 * editor decidiu.
 */
export interface ExplorationConfig {
  enabled: boolean;
  /** N da cota semanal. */
  slotsPerWeek: number;
  affinityMax: number;
  scoreGapPts: number;
}

export const EXPLORATION_CONFIG_DEFAULTS: ExplorationConfig = {
  enabled: true,
  slotsPerWeek: EXPLORATION_DEFAULT_SLOTS_PER_WEEK,
  affinityMax: EXPLORATION_AFFINITY_MAX,
  scoreGapPts: EXPLORATION_DEFAULT_SCORE_GAP_PTS,
};

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Normaliza a fatia `editorial_exploration` do `platform.config.json`. */
export function resolveExplorationConfig(raw: unknown): ExplorationConfig {
  if (!raw || typeof raw !== "object") return { ...EXPLORATION_CONFIG_DEFAULTS };
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled === undefined ? EXPLORATION_CONFIG_DEFAULTS.enabled : o.enabled === true,
    slotsPerWeek: positiveNumber(o.slots_per_week, EXPLORATION_CONFIG_DEFAULTS.slotsPerWeek),
    affinityMax: positiveNumber(o.affinity_max, EXPLORATION_CONFIG_DEFAULTS.affinityMax),
    scoreGapPts: positiveNumber(o.score_gap_pts, EXPLORATION_CONFIG_DEFAULTS.scoreGapPts),
  };
}

/**
 * Lê a config do `platform.config.json`. Fail-soft: config ausente/ilegível
 * cai nos defaults (a cota é correção de viés editorial, não gate — nunca
 * derruba o Stage 1 por causa de um JSON) — mas **avisando**: cair no default
 * em silêncio faria um `slots_per_week` editado à mão e quebrado parecer
 * respeitado.
 */
export function loadExplorationConfig(
  rootDir: string,
  log: (msg: string) => void = (msg) => console.error(msg),
): ExplorationConfig {
  const path = resolve(rootDir, "platform.config.json");
  if (!existsSync(path)) return { ...EXPLORATION_CONFIG_DEFAULTS };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return resolveExplorationConfig(parsed.editorial_exploration);
  } catch (err) {
    log(
      `[exploration-quota] platform.config.json ilegível (${(err as Error).message}) — ` +
        `usando defaults da cota (slots_per_week=${EXPLORATION_CONFIG_DEFAULTS.slotsPerWeek}) (#8370)`,
    );
    return { ...EXPLORATION_CONFIG_DEFAULTS };
  }
}

// ─── Semana / data ─────────────────────────────────────────────────────────

/** `"260919"` → `"2026-09-19"`; `null` quando não é um `AAMMDD` válido. */
export function editionIdToIsoDate(edition: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(edition.trim());
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `20${yy}-${mm}-${dd}`;
}

/**
 * Chave de semana ISO-8601 (`"2026-W38"`) — semana começa na segunda, e a
 * semana 1 é a que contém a primeira quinta-feira do ano. Usar ISO em vez de
 * "últimos 7 dias" torna a cota auditável: o editor consegue olhar o arquivo
 * e dizer quantos slots aquela semana gastou, sem depender de quando a
 * pergunta foi feita.
 */
export function isoWeekKey(isoDate: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(date.getTime())) return null;
  // Quinta-feira da mesma semana define o ano ISO.
  const dayNum = (date.getUTCDay() + 6) % 7; // segunda = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** `"260919"` → `"2026-W38"`. */
export function explorationWeekOfEdition(edition: string): string | null {
  const iso = editionIdToIsoDate(edition);
  return iso ? isoWeekKey(iso) : null;
}

// ─── Estado ────────────────────────────────────────────────────────────────

export type ExplorationOrigin = "promoted" | "already-selected";

/**
 * União discriminada de propósito: `url`/`origin` existem **se e somente se**
 * a edição consumiu um slot. Um `{ exploracao: false, url: "..." }` — ou um
 * `exploracao: true` sem URL — seria um registro que o join da Peça 3 conta
 * como exploração sem conseguir dizer qual destaque foi, e nada além da
 * disciplina do call site impediria isso se o tipo fosse um record plano.
 */
export type ExplorationRecord =
  | { week: string; exploracao: false; decided_at: string }
  | {
      week: string;
      exploracao: true;
      /** URL do destaque marcado. */
      url: string;
      /** Como o slot foi consumido — swap do pool ou item já selecionado por mérito. */
      origin: ExplorationOrigin;
      decided_at: string;
    };

export interface ExplorationState {
  editions: Record<string, ExplorationRecord>;
}

export function emptyExplorationState(): ExplorationState {
  return { editions: {} };
}

export const EXPLORATION_STATE_RELATIVE_PATH = "data/exploration-quota.json";

/**
 * Quantos slots a semana `week` já consumiu. `excludeEdition` tira a própria
 * edição da conta — sem isso, re-rodar o Stage 1 de uma edição que já marcou
 * exploração leria a si mesma como consumo alheio e se recusaria a repetir a
 * mesma decisão (resume viraria uma decisão editorial diferente, #6171).
 */
export function countWeekUsage(
  state: ExplorationState,
  week: string,
  excludeEdition?: string,
): number {
  let count = 0;
  for (const [edition, record] of Object.entries(state.editions)) {
    if (edition === excludeEdition) continue;
    if (record.week === week && record.exploracao) count += 1;
  }
  return count;
}

/** Puro — devolve um estado novo com a decisão desta edição registrada. */
export function recordExplorationDecision(
  state: ExplorationState,
  edition: string,
  record: ExplorationRecord,
): ExplorationState {
  return { ...state, editions: { ...state.editions, [edition]: record } };
}

export interface ExplorationStateRead {
  state: ExplorationState;
  /**
   * `true` quando o arquivo EXISTE mas não deu pra ler — distinto de "ainda
   * não existe". A diferença importa: arquivo ausente significa cota zerada
   * de verdade; arquivo corrompido significa **contador perdido**, e tratar
   * os dois como estado vazio faria a semana ganhar N slots extras em
   * silêncio (`data/` sincroniza por OneDrive entre 3 máquinas, e conflito
   * de sync durante escrita é incidente registrado no projeto).
   */
  corrupted: boolean;
  error?: string;
}

/** Fail-soft: nunca lança. Corrupção é sinalizada, não engolida. */
export function readExplorationState(path: string): ExplorationStateRead {
  if (!existsSync(path)) return { state: emptyExplorationState(), corrupted: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ExplorationState>;
    if (!parsed || typeof parsed !== "object" || !parsed.editions) {
      return {
        state: emptyExplorationState(),
        corrupted: true,
        error: "JSON válido mas sem a chave `editions`",
      };
    }
    return { state: { editions: parsed.editions }, corrupted: false };
  } catch (err) {
    return { state: emptyExplorationState(), corrupted: true, error: (err as Error).message };
  }
}

/**
 * Persiste o estado, atomicamente (tmp + rename, via `writeFileAtomic`) e sob
 * lock de arquivo — o mesmo par que `social-published-store.ts` usa, e pelo
 * mesmo motivo: `data/` é compartilhado entre máquinas/worktrees, então um
 * `writeFileSync` cru pode ser lido pela metade (produzindo exatamente a
 * corrupção que `readExplorationState` acima sinaliza) e dois processos em
 * read-modify-write podem perder a decisão um do outro.
 *
 * Devolve `false` (sem lançar) quando o diretório que hospedaria o arquivo
 * não existe — em produção o path é `data/…`, ausente em worktree isolado/
 * clone fresco; mesma degradação graciosa de `snippet-loader.ts` (#5227).
 * Não cria `data/` do nada de propósito: um `data/` fabricado por um worktree
 * seria um diretório órfão fora do OneDrive, indistinguível do real.
 */
export function writeExplorationState(path: string, state: ExplorationState): boolean {
  const dir = dirname(path);
  if (!existsSync(dir)) return false;
  const ordered: Record<string, ExplorationRecord> = {};
  for (const key of Object.keys(state.editions).sort()) ordered[key] = state.editions[key];
  withFileLock(`${path}.lock`, () => {
    writeFileAtomic(path, JSON.stringify({ editions: ordered }, null, 2) + "\n");
  });
  return true;
}

// ─── Seleção (pura) ────────────────────────────────────────────────────────

export interface ExplorationFinalistLike {
  url: string;
  score: number;
  bucket?: string;
  article?: (Record<string, unknown> & { url?: string; title?: string }) | undefined;
}

export interface ExplorationHighlightLike {
  score?: number;
  bucket?: string;
  reason?: string;
  url?: string;
  exploracao?: boolean;
  article?: (Record<string, unknown> & { url?: string; title?: string }) | undefined;
  [key: string]: unknown;
}

export interface ExplorationPromotion {
  /** URL do destaque marcado `exploracao: true`. */
  promoted_url: string;
  /** URL demovida — ausente quando o item já estava selecionado por mérito. */
  demoted_url?: string;
  origin: "promoted" | "already-selected";
  week: string;
  /** Slots já consumidos na semana ANTES desta decisão. */
  week_usage_before: number;
  slots_per_week: number;
  reason: string;
}

export interface ExplorationQuotaResult<H extends ExplorationHighlightLike> {
  highlights: H[];
  promotion?: ExplorationPromotion;
  /** Motivo de não ter havido promoção (só pra log/diagnóstico). */
  skipped?: string;
}

export interface ExplorationQuotaOptions {
  config: ExplorationConfig;
  week: string;
  weekUsageBefore: number;
  /**
   * Afinidade do item, `null` quando indeterminável (sem `data/`, sem CTR).
   * Injetada pelo caller (`assemble-scored.ts` usa `annotateAudienceAffinity`
   * sobre os sinais já carregados) pra manter esta função pura e testável sem
   * tocar em disco.
   */
  affinityOf: (item: { url?: string; article?: { url?: string } | undefined }) => number | null;
  /** Filtro extra do caller (ex: título placeholder, #4102). Default: aceita tudo. */
  isEligibleCandidate?: (finalist: ExplorationFinalistLike) => boolean;
}

function urlOf(h: { url?: string; article?: { url?: string } | undefined }): string | undefined {
  return h.url ?? h.article?.url;
}

/**
 * Piso do teste de exogeneidade: um item cujo título/resumo fala de big-tech
 * não é "conteúdo que não estávamos considerando", por afinidade nenhuma.
 *
 * **Por que este piso existe (achado do review desta PR, medido contra o
 * `data/` real):** `annotateAudienceAffinity` (#2063) nasceu pra outra
 * pergunta — casar tutorial com o stack declarado do leitor — e pontua por
 * match literal de nome de categoria/ferramenta no texto. Na prática
 * `"OpenAI apresenta o Sora 3"` e `"Google atualiza o Gemini"` dão afinidade
 * **0**, exatamente como `"Anatel abre consulta sobre IA"`, enquanto
 * `"Anthropic levanta rodada bilionária"` dá 0,23 por casar "treinamento"/
 * "infraestrutura" de raspão. Ou seja: afinidade baixa **não** é sinônimo de
 * assunto sub-representado, e sem este piso a cota gastaria seus 4 slots
 * semanais promovendo mais big-tech — o oposto do que a #8370 pede.
 *
 * O piso é NEGATIVO de propósito ("não é big-tech"), nunca um teste positivo
 * de novidade: a lista de termos é a MESMA de `editorial-concentration.ts`
 * (Peça 3), então o que a série mede como concentração é o que a cota se
 * recusa a chamar de exploração. O sinal positivo — "veio de query de
 * demanda" — é a Peça 1 (#8366) e ainda não existe; até lá a cota é
 * deliberadamente conservadora: prefere não gastar o slot a gastá-lo errado.
 */
function isBigTechItem(item: {
  article?: (Record<string, unknown> & { title?: string }) | undefined;
}): boolean {
  const article = item.article ?? {};
  const text = [article.title, article.summary].filter((v) => typeof v === "string").join(" ");
  return text.length > 0 && classifyItem(text).bigTech;
}

/**
 * Tira o `exploracao` que veio de fora (marca do `scorer-select`), pra que
 * quem marca seja sempre esta função. Devolve o MESMO array quando não há
 * nada a limpar — o caso normal não paga cópia.
 */
export function clearExploracaoFlags<H extends ExplorationHighlightLike>(highlights: H[]): H[] {
  if (!highlights.some((h) => h.exploracao !== undefined)) return highlights;
  return highlights.map((h) => {
    if (h.exploracao === undefined) return h;
    const { exploracao: _dropped, ...rest } = h;
    return rest as H;
  });
}

/**
 * Marca no máximo 1 destaque de exploração por edição, respeitando a cota
 * semanal. Pura — não muta os argumentos, não toca em disco.
 *
 * **O `exploracao` do output é sempre desta função, nunca herdado.**
 * `scorer-select.md` instrui o agent a marcar o campo quando ele mesmo
 * escolhe o item exógeno, e essa marca é bem-vinda como SINAL (decisão 2
 * abaixo a honra, preferindo-a ao teste mecânico de afinidade) — mas ela é
 * limpa de todos os outros highlights antes de qualquer coisa. Sem isso, uma
 * marca do agent em item de afinidade alta sobreviveria intacta enquanto a
 * decisão 3 marcava um segundo item, e a edição sairia com DOIS destaques
 * `exploracao: true` contra 1 slot debitado — a cota semanal viraria ficção e
 * a série da Peça 3 contaria errado.
 *
 * Guards de saída (no-op, antes de qualquer decisão): `enabled: false`, zero
 * highlights, ou cota da semana esgotada. Nos três a marca do agent também é
 * limpa: exploração não debitada não pode aparecer no output.
 *
 * Ordem das decisões:
 *
 * 1. Algum dos `EXPLORATION_DESTAQUE_SLOTS` primeiros highlights JÁ é
 *    exploração — marcado pelo agent, ou com afinidade abaixo do teto → marca
 *    esse (`origin: "already-selected"`) e consome o slot, sem trocar nada. O
 *    pool entregou exploração por mérito próprio; forçar uma troca por cima
 *    disso mexeria na edição à toa e inflaria a série da Peça 3 com
 *    exploração que não custou nada.
 * 2. Senão, promove o melhor finalista exógeno e competitivo, trocando o
 *    destaque de MENOR score entre os 3 primeiros — nunca o primeiro slot
 *    (mesma regra de `ensureNegativeImpactHighlight`: a correção de viés
 *    jamais derruba o melhor candidato do dia). Empate de score entre D2 e D3
 *    demove o de menor índice (D2), por ser a ordem editorial que o
 *    `scorer-select` já classificou como a mais forte das duas.
 *
 * `affinityOf` devolvendo `null` para tudo (sem `data/`) faz a função virar
 * no-op com `skipped` preenchido — nunca inventa exploração sem sinal.
 */
export function applyExplorationQuota<H extends ExplorationHighlightLike>(
  highlights: H[],
  finalists: ExplorationFinalistLike[],
  opts: ExplorationQuotaOptions,
): ExplorationQuotaResult<H> {
  const { config, week, weekUsageBefore, affinityOf } = opts;
  // Marca vinda do agent: lida como sinal (decisão 1), mas nunca propagada
  // sem ser debitada — ver docstring.
  const cleared = clearExploracaoFlags(highlights);
  if (!config.enabled) {
    return { highlights: cleared, skipped: "cota desabilitada em platform.config.json" };
  }
  if (highlights.length === 0) return { highlights: cleared, skipped: "sem highlights" };
  if (weekUsageBefore >= config.slotsPerWeek) {
    return {
      highlights: cleared,
      skipped: `cota semanal esgotada (${weekUsageBefore}/${config.slotsPerWeek} em ${week})`,
    };
  }

  const zoneEnd = Math.min(EXPLORATION_DESTAQUE_SLOTS, highlights.length);
  const isExogenous = (item: {
    url?: string;
    article?: (Record<string, unknown> & { url?: string; title?: string }) | undefined;
  }): boolean => {
    const affinity = affinityOf(item);
    if (affinity === null || affinity >= config.affinityMax) return false;
    return !isBigTechItem(item);
  };

  // (1) Já há exploração entre os destaques do dia — por marca do agent ou
  // por afinidade? A marca do agent vem primeiro: é julgamento editorial
  // sobre um item que o teste mecânico pode não pegar.
  const zoneIdx = [...Array(zoneEnd).keys()];
  const agentMarked = zoneIdx.find((i) => highlights[i].exploracao === true);
  const byAffinity = zoneIdx.find((i) => isExogenous(highlights[i]));
  const alreadyExploration = agentMarked ?? byAffinity;

  if (alreadyExploration !== undefined) {
    const next = cleared.slice();
    next[alreadyExploration] = { ...next[alreadyExploration], exploracao: true };
    return {
      highlights: next,
      promotion: {
        promoted_url: urlOf(highlights[alreadyExploration]) ?? "(desconhecida)",
        origin: "already-selected",
        week,
        week_usage_before: weekUsageBefore,
        slots_per_week: config.slotsPerWeek,
        reason:
          agentMarked !== undefined
            ? "destaque já marcado exploracao:true pelo scorer-select — slot debitado sem troca (#8370 Peça 2)"
            : `destaque já selecionado por mérito tem afinidade < ${config.affinityMax} (sinal exógeno) — ` +
              "marcado exploracao:true sem troca (#8370 Peça 2)",
      },
    };
  }

  // (2) Promover do pool.
  const highlightUrls = new Set(
    highlights.map(urlOf).filter((u): u is string => typeof u === "string"),
  );
  const zone = highlights.slice(0, zoneEnd);
  const weakest = Math.min(...zone.map((h) => h.score ?? Number.POSITIVE_INFINITY));
  const cutoff = Number.isFinite(weakest) ? weakest - config.scoreGapPts : Number.NEGATIVE_INFINITY;
  const eligible = opts.isEligibleCandidate ?? (() => true);

  const candidate = finalists
    .filter((f) => !highlightUrls.has(f.url))
    // USE MELHOR nunca vira destaque (#3436) — a cota não é brecha pra isso.
    .filter((f) => f.bucket !== "use_melhor")
    .filter((f) => f.score >= cutoff)
    .filter((f) => isExogenous(f))
    .filter(eligible)
    .sort((a, b) => b.score - a.score)[0];

  if (!candidate) {
    return { highlights: cleared, skipped: "nenhum finalista exógeno com score-base competitivo" };
  }

  // Nunca demove o primeiro slot (D1 do dia).
  let demoteIdx = -1;
  for (let i = 1; i < zoneEnd; i++) {
    const cur = highlights[i].score ?? -Infinity;
    if (demoteIdx === -1 || cur < (highlights[demoteIdx].score ?? -Infinity)) demoteIdx = i;
  }
  if (demoteIdx === -1) {
    return { highlights: cleared, skipped: "só há 1 destaque — a cota nunca derruba o D1" };
  }

  const demoted = highlights[demoteIdx];
  const next = cleared.slice();
  next[demoteIdx] = {
    ...demoted,
    score: candidate.score,
    bucket: candidate.bucket,
    article: candidate.article,
    url: candidate.url,
    exploracao: true,
    reason:
      `Cota de exploração (#8370 Peça 2): item com afinidade < ${config.affinityMax} e score-base ` +
      `competitivo, promovido no slot ${weekUsageBefore + 1}/${config.slotsPerWeek} da semana ${week}.`,
  } as H;

  return {
    highlights: next,
    promotion: {
      promoted_url: candidate.url,
      demoted_url: urlOf(demoted) ?? "(desconhecida)",
      origin: "promoted",
      week,
      week_usage_before: weekUsageBefore,
      slots_per_week: config.slotsPerWeek,
      reason:
        "nenhum destaque do dia tinha sinal exógeno; promovido o melhor finalista com " +
        `afinidade < ${config.affinityMax} dentro de ${config.scoreGapPts} pts do destaque mais fraco`,
    },
  };
}

// ─── Join para a medição (#8370 Peça 3) ────────────────────────────────────

/**
 * Converte o estado da cota no `Map<slug, boolean>` que `aggregateByMonth`
 * (`editorial-concentration.ts`) espera.
 *
 * O join é pela DATA editorial: o `lastmodBySlug` que
 * `measure-editorial-concentration.ts` já monta do `sitemap.xml` tem a data
 * editorial resolvida de cada página do acervo (honrando
 * `beehiiv-publish-date-overrides.json`, #4796), e a edição `AAMMDD` É essa
 * data. Nenhuma fonte de dado nova precisa existir dos dois lados.
 *
 * Datas sem página no acervo (edição ainda não sincronizada) simplesmente não
 * entram no mapa — a linha do mês continua degradando pra `null` quando nada
 * casou, como antes da Peça 2.
 */
export function explorationFlagsBySlug(
  state: ExplorationState,
  lastmodBySlug: Map<string, string | undefined>,
): Map<string, boolean> {
  const slugByDate = new Map<string, string>();
  for (const [slug, lastmod] of lastmodBySlug) {
    if (!lastmod) continue;
    // Primeiro slug vence: duas páginas no mesmo dia seriam ambíguas, e
    // escolher a última mudaria o resultado por ordem de leitura do diretório.
    if (!slugByDate.has(lastmod)) slugByDate.set(lastmod, slug);
  }
  const flags = new Map<string, boolean>();
  for (const [edition, record] of Object.entries(state.editions)) {
    const iso = editionIdToIsoDate(edition);
    if (!iso) continue;
    const slug = slugByDate.get(iso);
    if (!slug) continue;
    flags.set(slug, record.exploracao);
  }
  return flags;
}
