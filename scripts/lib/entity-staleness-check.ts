/**
 * entity-staleness-check.ts (#5125 — condição do editor 14/08/2026:
 * "a página nasce com regeneração automática, senão vira mais um artefato
 * que degrada sozinho — é literalmente o que já acontece com os hubs, ver
 * #5123 e #5124")
 *
 * Lógica PURA (sem I/O) do smoke-test que detecta quando o `mentions`
 * commitado de uma página de entidade (`scripts/lib/entities/{slug}.ts`)
 * ficou defasado em relação ao corpus sincronizado
 * (`data/beehiiv-cache/posts/*.json`): uma edição CONFIRMADA cujo
 * título/subtítulo casa `ENTITY_KEYWORD_PATTERNS[slug]`
 * (`scripts/lib/entities/patterns.ts`), mas cujo `editionSlug` não aparece
 * nem em `mentions` nem em `ENTITY_EXCLUDED_EDITIONS[slug]` (exclusão
 * editorial já registrada).
 *
 * **Espelha DELIBERADAMENTE a forma de `hub-staleness-check.ts` (#5123),
 * já implementado e em produção pro problema irmão dos hubs** — mesmo
 * mecanismo de aging (`computeFirstSeenMap`/`computeAgedStale`), mesmo
 * limiar (`filterOverdue`, default 3 dias) e mesmo padrão de idempotência
 * por fingerprint (`shouldAlarmStaleness`/`computeStalenessFingerprint`).
 * Nomes de função IDÊNTICOS aos de `hub-staleness-check.ts` (não
 * reexportados — cópia paralela pequena e pura, mesmo racional de
 * `formatDateShort` em `entity-page.ts`: os dois domínios são consumidores
 * irmãos, não um do outro) para que quem já conhece o mecanismo dos hubs
 * reconheça o de entidades de cara.
 *
 * Reusa a MESMA leitura de corpus e `collectHubSources` de
 * `generate-hub-sources.ts` — nunca duplica o parsing do cache.
 *
 * ─── Por que "alarmar", não "auto-escrever" (decisão de escopo, #5125) ────
 *
 * Escrever uma `EntityMention.summary` nova exige LER `content.free.web` da
 * edição inteira e sintetizar 1-3 frases PRÓPRIAS (critério anti-thin-
 * content, ver docstring de `entity-page.ts`) — julgamento editorial, não
 * mecânico. Auto-commitar prosa sintetizada sem revisão tem exatamente o
 * blast radius que `hub-staleness-check.ts` já documenta pro problema
 * irmão: "só alarma, NUNCA regenera nem commita" (#5123 item 4, decisão do
 * editor). Este módulo, portanto, resolve a METADE mecânica do problema
 * (nunca fica sabendo que ficou desatualizado sem avisar — o modo de falha
 * real por trás de #5123/#5124: silêncio) sem tentar a metade editorial
 * (que continua exigindo uma sessão humana/agente lendo o corpo e
 * escrevendo a síntese, o mesmo processo usado por esta própria unidade
 * pra publicar Apple).
 *
 * A OUTRA metade do "regeneração automática" desta condição — o HTML
 * SERVIDO nunca ficar desatualizado em relação ao `EntityContent` fonte —
 * é mecânica e É auto-regenerada de verdade por
 * `scripts/regenerate-entity-pages.ts` (chama `renderEntityPage` de novo e
 * reescreve o asset se divergir, sem intervenção humana), que TAMBÉM roda
 * este staleness check e alarma sobre a parte que não pode ser mecânica.
 */
import { collectHubSources } from "../generate-hub-sources.ts";
import type { RawCachedPost } from "../generate-arquivo-titles.ts";
import type { PublishDateOverridesResult } from "./beehiiv-publish-date.ts";
import { ENTITY_KEYWORD_PATTERNS, ENTITY_EXCLUDED_EDITIONS } from "./entities/patterns.ts";

/** Uma edição confirmada que casa `ENTITY_KEYWORD_PATTERNS[slug]` mas não
 * está no `mentions` commitado daquela entidade, e não consta como exclusão
 * editorial conhecida em `ENTITY_EXCLUDED_EDITIONS`. */
export interface StaleEntityEdition {
  entitySlug: string;
  date: string;
  editionSlug: string;
  editionTitle?: string;
  matchedHeadlines: string[];
}

export interface FindStaleEntityMentionsResult {
  stale: StaleEntityEdition[];
  warnings: string[];
}

/**
 * Pure: para cada entidade em `ENTITY_KEYWORD_PATTERNS`, roda
 * `collectHubSources` (mesmo mecanismo de match dos hubs, reusado sem
 * duplicação) sobre `posts` e devolve as linhas cujo `editionSlug` não
 * aparece nem no `mentions` já commitado (`mentionEditionSlugsBySlug`) nem
 * na lista de exclusão conhecida (`ENTITY_EXCLUDED_EDITIONS`).
 *
 * @param posts                       Cache Beehiiv (mesmo formato de
 *   `loadPosts()`, `generate-hub-sources.ts`) — só posts
 *   `status === "confirmed"` contam (delegado a `collectHubSources`).
 * @param mentionEditionSlugsBySlug   entity slug -> Set de `editionSlug` já
 *   presentes no `mentions` commitado daquela entidade. Injetável pra teste
 *   puro; o script `regenerate-entity-pages.ts` deriva isto chamando os
 *   loaders reais de `ENTITY_LOADERS` (`build-entity-page.ts`).
 * @param overridesResult             Repassado a `collectHubSources` —
 *   injetável pra teste determinístico.
 * @pure (com override explícito; sem ele, lê 1 arquivo commitado via
 *   `collectHubSources`'s próprio default)
 */
export function findStaleEntityMentions(
  posts: RawCachedPost[],
  mentionEditionSlugsBySlug: Readonly<Record<string, ReadonlySet<string>>>,
  overridesResult?: PublishDateOverridesResult,
): FindStaleEntityMentionsResult {
  const stale: StaleEntityEdition[] = [];
  const warnings: string[] = [];

  for (const [entitySlug, pattern] of Object.entries(ENTITY_KEYWORD_PATTERNS)) {
    const { rows, warnings: entityWarnings } =
      overridesResult !== undefined
        ? collectHubSources(posts, pattern, overridesResult)
        : collectHubSources(posts, pattern);
    for (const w of entityWarnings) warnings.push(`[${entitySlug}] ${w}`);

    const known = mentionEditionSlugsBySlug[entitySlug] ?? new Set<string>();
    const excluded = new Set(ENTITY_EXCLUDED_EDITIONS[entitySlug] ?? []);
    for (const row of rows) {
      if (known.has(row.editionSlug) || excluded.has(row.editionSlug)) continue;
      stale.push({
        entitySlug,
        date: row.date,
        editionSlug: row.editionSlug,
        editionTitle: row.editionTitle,
        matchedHeadlines: row.matchedHeadlines,
      });
    }
  }

  stale.sort((a, b) => a.date.localeCompare(b.date) || a.entitySlug.localeCompare(b.entitySlug));
  return { stale, warnings };
}

// ─── Aging (memória de 1ª-detecção) — mesmo molde de hub-staleness-check.ts

/** Chave estável de uma entrada stale — usada tanto no mapa de 1ª-detecção
 * quanto no fingerprint do alarme. */
export function staleEntryKey(entry: Pick<StaleEntityEdition, "entitySlug" | "editionSlug">): string {
  return `${entry.entitySlug}:${entry.editionSlug}`;
}

/** Mapa `staleEntryKey -> data ISO (YYYY-MM-DD) da 1ª detecção`. Persistido
 * pelo CLI entre execuções — dá noção de "há quanto tempo" a uma lista que,
 * sozinha, não carrega histórico nenhum. */
export type StaleFirstSeenMap = Record<string, string>;

/**
 * Pura: funde a lista de stale ATUAL com o mapa de 1ª-detecção da execução
 * ANTERIOR — entradas que já estavam no mapa mantêm a data original;
 * entradas novas ganham `todayISO`; entradas que saíram de `stale`
 * (mentions atualizado) são removidas do mapa — nunca acumula chave morta.
 *
 * @pure
 */
export function computeFirstSeenMap(
  stale: readonly StaleEntityEdition[],
  priorFirstSeen: Readonly<StaleFirstSeenMap>,
  todayISO: string,
): StaleFirstSeenMap {
  const next: StaleFirstSeenMap = {};
  for (const entry of stale) {
    const key = staleEntryKey(entry);
    next[key] = priorFirstSeen[key] ?? todayISO;
  }
  return next;
}

export interface AgedStaleEntityEdition extends StaleEntityEdition {
  /** `YYYY-MM-DD` — data em que esta entrada foi vista como stale pela
   * primeira vez (de `StaleFirstSeenMap`). */
  firstSeenDate: string;
  /** Dias corridos entre `firstSeenDate` e a data da checagem atual — sempre `>= 0`. */
  ageDays: number;
}

/**
 * Pura: junta `stale` com `firstSeenMap` (já mesclado por
 * `computeFirstSeenMap`) pra anexar `firstSeenDate`/`ageDays` a cada
 * entrada. Entrada sem chave no mapa (defensivo — não deveria acontecer se
 * o caller sempre mescla antes) cai em `ageDays: 0`, nunca lança.
 *
 * @pure
 */
export function computeAgedStale(
  stale: readonly StaleEntityEdition[],
  firstSeenMap: Readonly<StaleFirstSeenMap>,
  todayISO: string,
): AgedStaleEntityEdition[] {
  const todayMs = Date.parse(`${todayISO}T00:00:00Z`);
  return stale.map((entry) => {
    const firstSeenDate = firstSeenMap[staleEntryKey(entry)] ?? todayISO;
    const firstSeenMs = Date.parse(`${firstSeenDate}T00:00:00Z`);
    const ageDays =
      Number.isFinite(todayMs) && Number.isFinite(firstSeenMs)
        ? Math.max(0, Math.round((todayMs - firstSeenMs) / 86_400_000))
        : 0;
    return { ...entry, firstSeenDate, ageDays };
  });
}

/** Pura: entradas com `ageDays >= thresholdDays` — as que justificam alarme
 * (mesmo limiar default de `hub-staleness-check.ts`: 3 dias). */
export function filterOverdue(
  aged: readonly AgedStaleEntityEdition[],
  thresholdDays: number,
): AgedStaleEntityEdition[] {
  return aged.filter((e) => e.ageDays >= thresholdDays);
}

// ─── Idempotência do alarme (fingerprint + estado) ─────────────────────────

export interface EntityStalenessAlarmState {
  /** Fingerprint do conjunto vencido já alarmado (`null` = sem pendência conhecida, "re-armado"). */
  lastAlarmedFingerprint: string | null;
  lastCheckedAt: string | null;
}

export function emptyEntityStalenessAlarmState(): EntityStalenessAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pura — fingerprint estável (ordem-independente), sem `ageDays` (que
 * cresce todo dia) — só as chaves, pra não re-alarmar diariamente pelo
 * mesmo conjunto ainda não resolvido. */
export function computeEntityStalenessFingerprint(overdue: readonly AgedStaleEntityEdition[]): string {
  return overdue.map(staleEntryKey).sort().join("|");
}

export function advanceEntityStalenessState(fingerprint: string | null, now: Date): EntityStalenessAlarmState {
  return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: now.toISOString() };
}

/** Pura — `true` quando há pendência vencida E o fingerprint difere do
 * último já alarmado. */
export function shouldAlarmEntityStaleness(
  state: EntityStalenessAlarmState,
  overdue: readonly AgedStaleEntityEdition[],
): boolean {
  if (overdue.length === 0) return false;
  return computeEntityStalenessFingerprint(overdue) !== state.lastAlarmedFingerprint;
}

// ─── Corpo do e-mail de alarme (puro) ──────────────────────────────────────

/** Pura — monta assunto + corpo do e-mail de alarme (texto puro, mesmo
 * padrão de `hub-staleness-check.ts::buildStalenessAlarmEmail`). */
export function buildEntityStalenessAlarmEmail(
  overdue: readonly AgedStaleEntityEdition[],
  thresholdDays: number,
  now: Date = new Date(),
): { subject: string; body: string } {
  const subject = `[diar.ia.br] ${overdue.length} edição(ões) de entidade defasada(s) há ${thresholdDays}+ dias (especial.diar.ia.br)`;

  const lines: string[] = [
    `${overdue.length} edição(ões) casam ENTITY_KEYWORD_PATTERNS de alguma página de`,
    `entidade já publicada, mas não estão no \`mentions\` commitado há pelo menos`,
    `${thresholdDays} dia(s).`,
    "",
    "Isto NÃO é auto-corrigível: escrever a entrada nova exige ler",
    "content.free.web da edição e sintetizar um resumo PRÓPRIO (critério",
    "anti-thin-content) — trabalho editorial, não mecânico. Se a menção foi",
    "vista e descartada de propósito (redundante, sem desenvolvimento",
    "próprio), registrar em ENTITY_EXCLUDED_EDITIONS",
    "(scripts/lib/entities/patterns.ts) em vez de deixar o alarme repetir.",
    "",
    "Vencidas:",
  ];

  const bySlug = new Map<string, AgedStaleEntityEdition[]>();
  for (const e of overdue) {
    const list = bySlug.get(e.entitySlug) ?? [];
    list.push(e);
    bySlug.set(e.entitySlug, list);
  }
  for (const [entitySlug, entries] of [...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${entitySlug}:`);
    for (const e of entries) {
      const label = e.editionTitle ?? e.matchedHeadlines[0] ?? e.editionSlug;
      lines.push(`    - ${e.date} ${e.editionSlug} ("${label}") — defasada há ${e.ageDays} dia(s)`);
    }
  }

  lines.push(
    "",
    "Corrigir: editar scripts/lib/entities/{slug}.ts com a(s) menção(ões)",
    "nova(s) e rodar npx tsx scripts/build-entity-page.ts --entity {slug}",
    "(ou deixar a próxima corrida de scripts/regenerate-entity-pages.ts",
    "regenerar o HTML sozinha, uma vez commitado).",
    "",
    `(alarme automático — checagem rodou em ${now.toISOString()})`,
  );

  return { subject, body: lines.join("\n") };
}
