/**
 * scripts/lib/hub-staleness-check.ts (#4924)
 *
 * "Alternativa mais barata" da issue #4924 (item 5) — detecta quando o
 * dataset commitado de um hub (`scripts/lib/hubs/{slug}-sources.generated.json`,
 * gerado por `scripts/generate-hub-sources.ts`) ficou defasado em relação ao
 * cache Beehiiv sincronizado (`data/beehiiv-cache/posts/*.json`, atualizado
 * a cada edição no Stage 0, `beehiiv-sync.ts`): uma edição CONFIRMADA cujo
 * título/subtítulo casa `HUB_KEYWORD_PATTERNS` de algum hub, mas cujo
 * `editionSlug` não aparece no `.generated.json` daquele hub.
 *
 * **Não confundir com `scripts/lib/hub-match.ts` (#4907)** — aquele decide,
 * na hora da ESCRITA de uma edição nova, se as manchetes do dia casam
 * exatamente 1 hub (pra injetar um link contextual no corpo do destaque).
 * Este módulo audita o HISTÓRICO inteiro do cache contra os datasets já
 * commitados — pergunta diferente ("o que já foi publicado e nunca entrou
 * no dataset?"), reusando a mesma fonte de matching (`HUB_KEYWORD_PATTERNS`
 * + `stripAccents`, ambos de `generate-hub-sources.ts` — nunca duplicados
 * aqui) mas comparando contra dado JÁ commitado, não contra um draft em
 * memória.
 *
 * **Cenário histórico que motivou a issue (04/08 → 10/08/2026):**
 * `anthropic-claude-sources.generated.json` parou em 2026-08-03 e ficou
 * parado até 2026-08-10, enquanto saía a edição de 06/08 ("Modelo da
 * Anthropic finge ser humano em teste") que casava o pattern — 4 dias de
 * drift silencioso, só corrigido porque outro trabalho tropeçou nele. Esta
 * função reproduz exatamente essa janela em teste (fixture sintética, não
 * o dataset real — a edição real já entrou no dataset em 10/08 e um teste
 * ancorado nela testaria zero desde então).
 *
 * **Só detecta — nunca regenera nem commita.** A decisão de política de
 * commit (issue #4924, item 2) ficou pra quando a task systemd (item 1-4,
 * fora do escopo desta unidade) rodar. Aqui o output é só uma lista pra o
 * playbook do Stage 6 imprimir no resumo do gate.
 */
import { HUB_KEYWORD_PATTERNS, collectHubSources, type HubSourceEntry } from "../generate-hub-sources.ts";
import type { RawCachedPost } from "../generate-arquivo-titles.ts";
import type { PublishDateOverridesResult } from "./beehiiv-publish-date.ts";
import type { AlarmFinding } from "./alarm-issues.ts";

/** Uma edição confirmada que casa o pattern de um hub mas não está no
 * dataset commitado daquele hub. */
export interface StaleHubEdition {
  /** Slug do hub — chave de `HUB_KEYWORD_PATTERNS`. */
  hubSlug: string;
  /** `YYYY-MM-DD`, mesma resolução de `HubSourceEntry.date`. */
  date: string;
  editionSlug: string;
  editionTitle?: string;
  matchedHeadlines: string[];
}

export interface FindStaleHubEditionsResult {
  stale: StaleHubEdition[];
  /** Warnings propagados de `collectHubSources` por hub (post casado mas
   * sem slug/publish_date resolvível) — nunca descartados em silêncio,
   * mesmo racional do módulo que este reusa. Prefixados com `[{hubSlug}]`. */
  warnings: string[];
}

/**
 * Pure: para cada hub em `HUB_KEYWORD_PATTERNS`, roda `collectHubSources`
 * sobre `posts` e devolve as linhas cujo `editionSlug` NÃO aparece no
 * dataset commitado correspondente (`datasetsBySlug[hubSlug]`). Hub sem
 * entrada em `datasetsBySlug` é tratado como dataset vazio (tudo que casar
 * o pattern conta como stale) — nunca lança.
 *
 * @param posts            Cache Beehiiv (mesmo formato de `loadPosts()`,
 *   `generate-hub-sources.ts`) — só posts `status === "confirmed"` contam
 *   (delegado a `collectHubSources`).
 * @param datasetsBySlug    hub slug -> linhas já commitadas daquele hub
 *   (`{slug}-sources.generated.json` parseado). Injetável pra teste puro;
 *   `loadHubDatasets()` lê os arquivos reais.
 * @param overridesResult   Repassado a `collectHubSources` — injetável pra
 *   teste determinístico (default: lê `beehiiv-publish-date-overrides.json`
 *   commitado, mesmo default de `collectHubSources`).
 * @pure (com override explícito; sem ele, lê 1 arquivo commitado via
 *   `collectHubSources`'s próprio default)
 */
export function findStaleHubEditions(
  posts: RawCachedPost[],
  datasetsBySlug: Readonly<Record<string, readonly HubSourceEntry[]>>,
  overridesResult?: PublishDateOverridesResult,
): FindStaleHubEditionsResult {
  const stale: StaleHubEdition[] = [];
  const warnings: string[] = [];

  for (const [hubSlug, pattern] of Object.entries(HUB_KEYWORD_PATTERNS)) {
    const { rows, warnings: hubWarnings } =
      overridesResult !== undefined
        ? collectHubSources(posts, pattern, overridesResult)
        : collectHubSources(posts, pattern);
    for (const w of hubWarnings) warnings.push(`[${hubSlug}] ${w}`);

    const known = new Set((datasetsBySlug[hubSlug] ?? []).map((row) => row.editionSlug));
    for (const row of rows) {
      if (!known.has(row.editionSlug)) {
        stale.push({
          hubSlug,
          date: row.date,
          editionSlug: row.editionSlug,
          editionTitle: row.editionTitle,
          matchedHeadlines: row.matchedHeadlines,
        });
      }
    }
  }

  stale.sort((a, b) => a.date.localeCompare(b.date) || a.hubSlug.localeCompare(b.hubSlug));
  return { stale, warnings };
}

/**
 * Comandos de regen sugeridos pra um conjunto de hubs defasados — mesma
 * sequência que a docstring de `generate-hub-sources.ts` e o item 6 da
 * issue #4924 recomendam (regen por hub, depois `build-hub-page.ts --all`
 * uma vez só pra todos).
 *
 * @pure
 */
export function buildRegenCommands(staleHubSlugs: readonly string[]): string[] {
  const uniqueSorted = [...new Set(staleHubSlugs)].sort();
  if (uniqueSorted.length === 0) return [];
  return [
    ...uniqueSorted.map((slug) => `npx tsx scripts/generate-hub-sources.ts --hub ${slug}`),
    "npx tsx scripts/build-hub-page.ts --all",
  ];
}

// ─── Persistência + alarme (#5123 — itens 1-4 órfãos do #4924) ─────────────
//
// O que está acima (`findStaleHubEditions`) só DETECTA — não sabe há quanto
// tempo uma edição está defasada, porque cada checagem é uma foto isolada.
// As funções abaixo dão memória a essa foto: `computeFirstSeenMap` reusa a
// data de 1ª detecção de uma entrada que já era stale na checagem ANTERIOR
// (persistida em `data/hubs/staleness-state.json` pelo CLI,
// `scripts/hub-staleness-check.ts`) e marca `todayISO` só pra entradas
// NOVAS — entradas que já não são mais stale (foram regeneradas) somem do
// mapa (nunca acumulam lixo). `computeAgedStale` deriva `ageDays` a partir
// desse mapa; `filterOverdue`/`shouldAlarmStaleness`/`buildStalenessAlarmEmail`
// decidem o alarme com o MESMO padrão de idempotência por fingerprint já
// usado em `hub-drift-check.ts`/`worker-drift-check.ts`/`apoios-diff-alarm.ts`
// (#4750/#4723/#4485): alarma quando o conjunto de entradas vencidas muda de
// forma (nova entrada cruzou o limiar, ou uma foi resolvida), não a cada
// execução idêntica.

/** Chave estável de uma entrada stale — usada tanto no mapa de 1ª-detecção
 * quanto no fingerprint do alarme. */
export function staleEntryKey(entry: Pick<StaleHubEdition, "hubSlug" | "editionSlug">): string {
  return `${entry.hubSlug}:${entry.editionSlug}`;
}

/** Pura: agrupa entradas vencidas por `hubSlug` — granularidade REAL da
 * issue (#6254: a versão anterior gerava 1 `AlarmFinding` por entrada,
 * ou seja, por `(hub × edição)` — 11 issues pra 4 hubs na rodada 260826).
 * Ordena por `hubSlug` (determinístico) e preserva a ordem de `overdue`
 * dentro de cada grupo (já vem ordenada por `findStaleHubEditions`). */
export function groupOverdueByHub(
  overdue: readonly AgedStaleHubEdition[],
): { hubSlug: string; entries: AgedStaleHubEdition[] }[] {
  const byHub = new Map<string, AgedStaleHubEdition[]>();
  for (const entry of overdue) {
    const list = byHub.get(entry.hubSlug) ?? [];
    list.push(entry);
    byHub.set(entry.hubSlug, list);
  }
  return [...byHub.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hubSlug, entries]) => ({ hubSlug, entries }));
}

/** Fingerprint fixo do achado "hub defasado" (#6254). Antes do #6254 o
 * fingerprint era `staleEntryKey(entry)` = `${hubSlug}:${editionSlug}` —
 * como o MARCADOR de dedup é sempre `${check}:${fingerprint}`
 * (`alarmFindingMarker`, `scripts/lib/alarm-issues.ts`) e `check` já É o
 * `hubSlug`, o marcador saía com o hub duplicado
 * (`anthropic-claude:anthropic-claude:edicao`). Com a granularidade agora
 * fixada em "1 issue por hub" (`check` já identifica o achado sozinho), o
 * fingerprint não precisa carregar mais nenhuma informação — só não pode
 * repetir `check`. Constante, não vazio, pra ficar legível no marcador
 * (`anthropic-claude:dataset-defasado`) e não colidir com o fingerprint
 * "vazio" de nenhum outro achado deste `check`. */
export const STALE_HUB_FINDING_FINGERPRINT = "dataset-defasado";

/** Converte TODAS as entradas vencidas de UM hub (agrupadas por
 * `groupOverdueByHub`) num único `AlarmFinding` que `scripts/lib/alarm-issues.ts`
 * consome (#6151, granularidade corrigida no #6254 — mesmo padrão de
 * `hub-drift-check.ts`'s `toAlarmFinding`, mas 1:N em vez de 1:1). `check` =
 * slug do hub (cada hub é seu próprio eixo, mesma convenção de
 * `hub-drift-check.ts`). `fingerprint` = `STALE_HUB_FINDING_FINGERPRINT`
 * (constante — ver docstring dela) — a issue de um hub é estável entre
 * execuções INDEPENDENTE de quais edições específicas estão vencidas no
 * momento; o corpo lista todas elas. `family: "estado"` — a condição
 * observada ("este hub tem alguma edição fora do dataset commitado?") é
 * RE-CHECÁVEL a cada execução: assim que a ÚLTIMA edição vencida do hub for
 * regenerada, o hub some de `overdue` e o mecanismo de streak
 * comenta/fecha a issue sozinho (mesmo racional de `hub-drift-check.ts`).
 * Toda entrada nasce `P3` — cleanup/regen manual sem urgência de produção
 * (diferente do `hub-drift-check.ts`, que é `P2` porque um hub fora do ar é
 * um 404 real pro leitor; aqui é só um link interno que ainda não existe).
 *
 * **Limitação conhecida (#6254, registrada no PR — fora do escopo desta
 * unidade):** se uma NOVA edição do mesmo hub ficar vencida enquanto a
 * issue já está aberta, `ensureAlarmIssue` REUSA a issue existente (mesmo
 * fingerprint) sem editar o corpo — a lista de edições da issue fica
 * congelada na última vez que ela foi criada/reaberta, mesmo que o
 * conjunto real (`overdue`) tenha crescido. A issue permanece correta
 * quanto ao FATO "este hub está defasado" (não gera issue duplicada, não
 * fecha cedo demais), só a lista detalhada pode ficar desatualizada — o
 * snapshot diário (`data/hubs/staleness-{data}.json`) é a fonte sempre
 * atual caso o corpo da issue precise ser conferido. */
export function toAlarmFinding(hubSlug: string, entries: readonly AgedStaleHubEdition[]): AlarmFinding {
  const sorted = [...entries].sort(
    (a, b) => a.date.localeCompare(b.date) || a.editionSlug.localeCompare(b.editionSlug),
  );
  return {
    check: hubSlug,
    fingerprint: STALE_HUB_FINDING_FINGERPRINT,
    family: "estado",
    title: `[diar.ia.br] hub "${hubSlug}" defasado — ${sorted.length} edição(ões) fora do dataset`,
    body: [
      "Achado automático do alarme `Diaria-Hub-Staleness-Check`",
      "(`scripts/hub-staleness-check.ts`).",
      "",
      `Hub: ${hubSlug}`,
      `${sorted.length} edição(ões) defasada(s):`,
      ...sorted.map((entry) => {
        const label = entry.editionTitle ?? entry.matchedHeadlines[0] ?? entry.editionSlug;
        return `  - ${entry.date} ${entry.editionSlug} ("${label}") — defasada desde ${entry.firstSeenDate} (${entry.ageDays} dia(s))`;
      }),
      "",
      "A(s) edição(ões) acima casam HUB_KEYWORD_PATTERNS deste hub mas seu slug",
      `não aparece no dataset commitado (\`scripts/lib/hubs/${hubSlug}-sources.generated.json\`).`,
      "",
      "Regenerar (decisão editorial de timing, #4924 item 2 — nunca automático):",
      `  npx tsx scripts/generate-hub-sources.ts --hub ${hubSlug}`,
      "  npx tsx scripts/build-hub-page.ts --all",
      "",
      "Esta issue é criada automaticamente pelo alarme (#6151/#6254, mesmo padrão",
      "do #5339) e cobre TODAS as edições vencidas deste hub numa única issue.",
      "Será comentada/fechada sozinha quando NENHUMA edição do hub aparecer mais",
      "como vencida (dataset regenerado) por execuções consecutivas. Se uma nova",
      "edição vencer enquanto esta issue está aberta, o corpo NÃO é atualizado",
      "automaticamente (#6254, limitação conhecida) — conferir",
      "`data/hubs/staleness-{data}.json` pro snapshot mais atual.",
    ].join("\n"),
    labels: ["enhancement"],
    priority: "P3",
  };
}

/** Mapa `staleEntryKey -> data ISO (YYYY-MM-DD) da 1ª detecção`. Persistido
 * pelo CLI entre execuções — é o que dá noção de "há quanto tempo" a uma
 * lista que, sozinha, não carrega histórico nenhum. */
export type StaleFirstSeenMap = Record<string, string>;

/**
 * Pura: funde a lista de stale ATUAL com o mapa de 1ª-detecção da execução
 * ANTERIOR — entradas que já estavam no mapa mantêm a data original
 * (persistência da "memória"); entradas novas ganham `todayISO`; entradas
 * que saíram de `stale` (regeneradas desde a última checagem) são
 * removidas do mapa — nunca acumula chave morta indefinidamente.
 *
 * @pure
 */
export function computeFirstSeenMap(
  stale: readonly StaleHubEdition[],
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

export interface AgedStaleHubEdition extends StaleHubEdition {
  /** `YYYY-MM-DD` — data em que esta entrada foi vista como stale pela
   * primeira vez (de `StaleFirstSeenMap`). */
  firstSeenDate: string;
  /** Dias corridos entre `firstSeenDate` e a data da checagem atual
   * (`todayISO` passado a `computeAgedStale`) — sempre `>= 0`. */
  ageDays: number;
}

/**
 * Pura: junta `stale` com `firstSeenMap` (já mesclado por
 * `computeFirstSeenMap`) pra anexar `firstSeenDate`/`ageDays` a cada
 * entrada. Entrada sem chave no mapa (não deveria acontecer se o caller
 * sempre mescla antes de chamar isto — defensivo) cai em `ageDays: 0`,
 * `firstSeenDate: todayISO` — nunca lança.
 *
 * @pure
 */
export function computeAgedStale(
  stale: readonly StaleHubEdition[],
  firstSeenMap: Readonly<StaleFirstSeenMap>,
  todayISO: string,
): AgedStaleHubEdition[] {
  const todayMs = Date.parse(`${todayISO}T00:00:00Z`);
  return stale.map((entry) => {
    const firstSeenDate = firstSeenMap[staleEntryKey(entry)] ?? todayISO;
    const firstSeenMs = Date.parse(`${firstSeenDate}T00:00:00Z`);
    const ageDays = Number.isFinite(todayMs) && Number.isFinite(firstSeenMs)
      ? Math.max(0, Math.round((todayMs - firstSeenMs) / 86_400_000))
      : 0;
    return { ...entry, firstSeenDate, ageDays };
  });
}

/** Pura: entradas com `ageDays >= thresholdDays` — as que justificam
 * alarme (#5123 item 3, default sugerido pela issue: 3 dias). */
export function filterOverdue(
  aged: readonly AgedStaleHubEdition[],
  thresholdDays: number,
): AgedStaleHubEdition[] {
  return aged.filter((e) => e.ageDays >= thresholdDays);
}

export interface StalenessAlarmState {
  /** Fingerprint do conjunto vencido já alarmado (`null` = nenhum pendente
   * conhecido, "re-armado" — mesmo contrato de `HubDriftAlarmState`). */
  lastAlarmedFingerprint: string | null;
  lastCheckedAt: string | null;
}

export function emptyStalenessAlarmState(): StalenessAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pura: fingerprint estável (ordem-independente) do conjunto de entradas
 * vencidas — usado pra idempotência do alarme. NÃO inclui `ageDays` (que
 * cresce todo dia) — só as chaves — pra não re-alarmar diariamente pelo
 * mesmo conjunto ainda não resolvido. */
export function computeStalenessFingerprint(overdue: readonly AgedStaleHubEdition[]): string {
  return overdue.map(staleEntryKey).sort().join("|");
}

/** Pura — mesmo contrato de `advanceHubDriftState`. */
export function advanceStalenessState(fingerprint: string | null, now: Date): StalenessAlarmState {
  return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: now.toISOString() };
}

/** Pura — alarma quando há pendência E o fingerprint mudou desde o último
 * alarme (novo conjunto, ou reapareceu depois de resolvido). */
export function shouldAlarmStaleness(
  state: StalenessAlarmState,
  overdue: readonly AgedStaleHubEdition[],
): boolean {
  if (overdue.length === 0) return false;
  return computeStalenessFingerprint(overdue) !== state.lastAlarmedFingerprint;
}

/** Pura: assunto + corpo (texto puro) do e-mail de alarme — mesmo padrão
 * de `buildHubDriftAlarmEmail`. `issueRefs` (#6151, opcional; chave mudou
 * de `staleEntryKey` pra `hubSlug` no #6254 — granularidade da issue agora
 * é por hub, não por hub+edição) — mapa `hubSlug -> {issueNumber, url,
 * action, error}` de `scripts/lib/alarm-issues.ts`, usado pra citar a
 * issue de cada hub vencido (1 citação por hub, não repetida por edição).
 * `undefined` (dry-run, ou wiring ainda não chamado) omite a citação sem
 * quebrar nada — mesmo fallback de `buildHubDriftAlarmEmail`. */
export function buildStalenessAlarmEmail(
  overdue: readonly AgedStaleHubEdition[],
  thresholdDays: number,
  now: Date = new Date(),
  issueRefs?: ReadonlyMap<string, { issueNumber: number | null; url: string | null; action: string; error?: string }>,
): { subject: string; body: string } {
  const subject = `[diar.ia.br] ${overdue.length} edição(ões) defasada(s) nos hubs temáticos há ${thresholdDays}+ dias`;

  const lines: string[] = [
    `${overdue.length} edição(ões) casam HUB_KEYWORD_PATTERNS de algum hub temático`,
    `mas não estão no dataset commitado há pelo menos ${thresholdDays} dia(s) — cada`,
    "uma é um link interno que devia existir e não existe (ver #5121 pra por que",
    "isso importa pra SEO/citação).",
    "",
    "Vencidas:",
  ];
  const byHub = new Map<string, AgedStaleHubEdition[]>();
  for (const e of overdue) {
    const list = byHub.get(e.hubSlug) ?? [];
    list.push(e);
    byHub.set(e.hubSlug, list);
  }
  for (const [hubSlug, entries] of [...byHub.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${hubSlug}:`);
    const ref = issueRefs?.get(hubSlug);
    if (ref) {
      lines.push(
        ref.action === "failed"
          ? `    Issue: falha ao criar/reusar (${ref.error})`
          : `    Issue: #${ref.issueNumber} (${ref.url})`,
      );
    }
    for (const e of entries) {
      const label = e.editionTitle ?? e.matchedHeadlines[0] ?? e.editionSlug;
      lines.push(`    - ${e.date} ${e.editionSlug} ("${label}") — defasada há ${e.ageDays} dia(s)`);
    }
  }
  lines.push(
    "",
    "Regenerar:",
    ...buildRegenCommands([...byHub.keys()]).map((cmd) => `  ${cmd}`),
    "",
    `(alarme automático — checagem rodou em ${now.toISOString()})`,
  );

  return { subject, body: lines.join("\n") };
}

/**
 * Formata `stale` num bloco de texto pronto pra imprimir no resumo do gate
 * do Stage 6 — ou string vazia se `stale` estiver vazio (nada a reportar,
 * caller decide se omite a seção inteira).
 *
 * @pure
 */
export function formatStaleHubReport(stale: readonly StaleHubEdition[]): string {
  if (stale.length === 0) return "";

  const byHub = new Map<string, StaleHubEdition[]>();
  for (const entry of stale) {
    const list = byHub.get(entry.hubSlug) ?? [];
    list.push(entry);
    byHub.set(entry.hubSlug, list);
  }

  const lines: string[] = [
    `⚠ HUBS DEFASADOS — ${stale.length} edição(ões) casam HUB_KEYWORD_PATTERNS mas não estão no dataset commitado:`,
    "",
  ];
  for (const [hubSlug, entries] of [...byHub.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${hubSlug}:`);
    for (const entry of entries) {
      const label = entry.editionTitle ?? entry.matchedHeadlines[0] ?? entry.editionSlug;
      lines.push(`  - ${entry.date} ${entry.editionSlug} ("${label}")`);
    }
    lines.push("");
  }
  lines.push("Regenerar:");
  for (const cmd of buildRegenCommands([...byHub.keys()])) lines.push(`  ${cmd}`);

  return lines.join("\n");
}
