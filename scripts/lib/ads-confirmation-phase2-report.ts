/**
 * scripts/lib/ads-confirmation-phase2-report.ts (#8543, fase 2)
 *
 * Miolo PURO do relatório da fase 2 da #8543: por canal pago (Google, Meta),
 * compara cadastro × pageview de `/confirmada` × import (o que os dois lotes
 * de confirmação já subiram) × confirmados reais. É o insumo da decisão da
 * fase 3 (promover a confirmação importada a meta primária, refazer o
 * CPA-alvo do Google, definir teto na Meta) — que é do EDITOR. Este módulo
 * só mede; não recomenda nem altera nada.
 *
 * ## Fontes (todas locais, leitura)
 *
 * - **Cadastros e confirmados**: roster do Kit (`data/kit-sub-state/current.json`,
 *   escrito por `kit-subscriber-state-transition-alarm.ts`). Cadastro = assinante
 *   com `created_at` (dia BRT) na janela; confirmado = `state === "active"` HOJE.
 *   Quem confirmou e depois saiu (`cancelled`/`bounced`/`complained`) conta como
 *   não confirmado — limitação aceita, contada à parte em `saiu`.
 * - **Import Google**: índice do lote `upload-google-ads-confirmations.ts`
 *   (`data/google-ads/_confirmation-conversions-sent.json`), status `submitted`.
 * - **Import Meta**: índice do lote `meta-capi-confirmations-send.ts`
 *   (`data/meta-capi/_confirmation-sent.json`), status `sent`; os `skipped-*`
 *   aparecem como perda.
 * - **Pageview `/confirmada`**: cache do GA4 (`data/ga4-cache/latest.json`,
 *   `top_pages`). O cache guarda a página AGREGADA na janela do próprio cache,
 *   sem quebra por canal — por isso a coluna sai como total único, com a janela
 *   do GA4 declarada, e nunca é rateada por canal (rateio seria número
 *   inventado).
 *
 * ## Canal
 *
 * `origem_paga` (`google-ads`/`meta-ads`, com ou sem sufixo de campanha com
 * fronteira de traço — `meta-ads-260901` é Meta, `meta-adsxyz` não; mesma regra
 * de `isAllowedClientUtmSource`, #10412) primeiro; sem ela, o prefixo de
 * `origem_click_id` (`gclid:` → Google, `fbclid:` → Meta). O segundo caminho é
 * contado à parte (`viaClickIdOnly`): desde o #10230 o `fbclid:` pode vir do
 * cookie `_fbc` (90 dias) sem reclassificar o canal, então ele é sinal mais
 * fraco que `origem_paga`.
 *
 * ## Privacidade
 *
 * Só contagens saem daqui. O roster tem e-mail em claro; nenhum campo dele é
 * copiado pra saída.
 */

export type Phase2Channel = "google" | "meta" | "outros";

export interface Phase2RosterEntry {
  id: number;
  state: string;
  created_at: string;
  fields?: Record<string, string | null> | null;
}

export interface Phase2IndexEntry {
  status: string;
}

export interface Phase2Ga4Confirmada {
  pageviews: number;
  windowDays: number | null;
  fetchedAt: string | null;
}

export interface Phase2Inputs {
  roster: readonly Phase2RosterEntry[];
  /** `null` = fonte indisponível (motivo em `sourceNotes`). */
  googleIndex: Readonly<Record<string, Phase2IndexEntry>> | null;
  metaIndex: Readonly<Record<string, Phase2IndexEntry>> | null;
  ga4: Phase2Ga4Confirmada | null;
  since: string;
  until: string;
  sourceNotes?: readonly string[];
}

export interface Phase2ChannelRow {
  channel: Phase2Channel;
  cadastros: number;
  viaClickIdOnly: number;
  comClickIdDoCanal: number;
  confirmados: number;
  pendentes: number;
  saiu: number;
  /** confirmados / cadastros (0..1); `null` sem cadastro. */
  taxaConfirmacao: number | null;
  importGoogle: number | null;
  importMeta: number | null;
  metaForaDaJanela: number | null;
  metaOutroCanal: number | null;
  metaFalhaPermanente: number | null;
  /**
   * Importados pelo lote do canal "dono" (Google pra google, Meta pra meta)
   * que NÃO estão `active` hoje (confirmaram, foram importados e saíram, ou
   * divergência de estado). Ficam fora do numerador da cobertura (#10412).
   * `null` = índice do canal indisponível ou canal sem dono (`outros`).
   */
  importCanalNaoAtivo: number | null;
  /**
   * Cobertura do import do canal "dono" (0..1): (importados pelo lote do canal
   * E `active` hoje) / confirmados. Numerador e denominador olham o MESMO
   * estado atual, então nunca passa de 100% (#10412 — antes o numerador
   * contava todo importado, inclusive quem saiu depois, e o denominador só os
   * `active`). Quem foi importado e saiu aparece em `importCanalNaoAtivo`.
   */
  coberturaImportCanal: number | null;
}

export interface Phase2Report {
  since: string;
  until: string;
  rows: Phase2ChannelRow[];
  confirmadaPageviews: Phase2Ga4Confirmada | null;
  sourceNotes: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Dia BRT (`AAAA-MM-DD`) de um ISO; `null` se ilegível. @pure */
export function brtDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/**
 * `origem_paga` normalizada casa o canal `prefix`: igual, ou com sufixo de
 * campanha depois de um traço (`meta-ads-260901`). Mesma fronteira de
 * `isAllowedClientUtmSource` (`scripts/lib/shared/client-utm-allowlist.ts`) e
 * do que `resolveOrigemPagaWithClickIdFallback` preserva (#10412). @pure
 */
function origemPagaMatches(origemPaga: string, prefix: string): boolean {
  return origemPaga === prefix || origemPaga.startsWith(`${prefix}-`);
}

/** Canal pago de um assinante + se veio só do click id. @pure */
export function classifyPhase2Channel(
  fields: Record<string, string | null> | null | undefined,
): { channel: Phase2Channel; viaClickIdOnly: boolean; clickIdChannel: Phase2Channel | null } {
  const origemPaga = (fields?.origem_paga ?? "").trim().toLowerCase();
  const clickId = (fields?.origem_click_id ?? "").trim().toLowerCase();
  const clickIdChannel: Phase2Channel | null = clickId.startsWith("gclid:")
    ? "google"
    : clickId.startsWith("fbclid:")
      ? "meta"
      : null;
  if (origemPagaMatches(origemPaga, "google-ads")) return { channel: "google", viaClickIdOnly: false, clickIdChannel };
  if (origemPagaMatches(origemPaga, "meta-ads")) return { channel: "meta", viaClickIdOnly: false, clickIdChannel };
  if (clickIdChannel) return { channel: clickIdChannel, viaClickIdOnly: true, clickIdChannel };
  return { channel: "outros", viaClickIdOnly: false, clickIdChannel };
}

function ratio(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

/** Extrai a linha `/confirmada` do cache do GA4 (`latest.json`). @pure */
export function extractConfirmadaFromGa4Cache(cache: unknown): Phase2Ga4Confirmada | null {
  if (!cache || typeof cache !== "object") return null;
  const c = cache as { top_pages?: unknown; window_days?: unknown; fetched_at?: unknown };
  if (!Array.isArray(c.top_pages)) return null;
  let pageviews = 0;
  let found = false;
  for (const row of c.top_pages) {
    const r = row as { pagePath?: unknown; screenPageViews?: unknown };
    const path = typeof r.pagePath === "string" ? r.pagePath.replace(/\/+$/, "") : "";
    if (path !== "/confirmada") continue;
    const n = Number(r.screenPageViews);
    if (Number.isFinite(n)) {
      pageviews += n;
      found = true;
    }
  }
  if (!found) return null;
  return {
    pageviews,
    windowDays: typeof c.window_days === "number" ? c.window_days : null,
    fetchedAt: typeof c.fetched_at === "string" ? c.fetched_at : null,
  };
}

/** Monta o relatório. Janela por dia BRT de `created_at`, inclusiva. @pure */
export function buildPhase2Report(input: Phase2Inputs): Phase2Report {
  if (!DATE_RE.test(input.since) || !DATE_RE.test(input.until)) {
    throw new Error(`janela inválida: since=${input.since} until=${input.until} (esperado AAAA-MM-DD)`);
  }
  if (input.since > input.until) throw new Error(`janela invertida: ${input.since} > ${input.until}`);
  const channels: Phase2Channel[] = ["google", "meta", "outros"];
  const rows = new Map<Phase2Channel, Phase2ChannelRow>();
  for (const ch of channels) {
    rows.set(ch, {
      channel: ch,
      cadastros: 0,
      viaClickIdOnly: 0,
      comClickIdDoCanal: 0,
      confirmados: 0,
      pendentes: 0,
      saiu: 0,
      taxaConfirmacao: null,
      importGoogle: input.googleIndex ? 0 : null,
      importMeta: input.metaIndex ? 0 : null,
      metaForaDaJanela: input.metaIndex ? 0 : null,
      metaOutroCanal: input.metaIndex ? 0 : null,
      metaFalhaPermanente: input.metaIndex ? 0 : null,
      importCanalNaoAtivo: null,
      coberturaImportCanal: null,
    });
  }

  // Importados pelo lote do canal dono E `active` hoje — numerador da cobertura.
  const importCanalAtivo = new Map<Phase2Channel, number>(channels.map((c) => [c, 0]));
  for (const s of input.roster) {
    const day = brtDay(s.created_at);
    if (!day || day < input.since || day > input.until) continue;
    const { channel, viaClickIdOnly, clickIdChannel } = classifyPhase2Channel(s.fields);
    const row = rows.get(channel)!;
    row.cadastros++;
    if (viaClickIdOnly) row.viaClickIdOnly++;
    if (clickIdChannel && clickIdChannel === channel) row.comClickIdDoCanal++;
    if (s.state === "active") row.confirmados++;
    else if (s.state === "inactive") row.pendentes++;
    else row.saiu++;
    const key = `kit-${s.id}`;
    const g = input.googleIndex?.[key];
    const googleImported = !!g && g.status === "submitted";
    if (googleImported) row.importGoogle!++;
    const m = input.metaIndex?.[key];
    const metaImported = !!m && m.status === "sent";
    const ownImported = channel === "google" ? googleImported : channel === "meta" ? metaImported : false;
    if (ownImported && s.state === "active") importCanalAtivo.set(channel, importCanalAtivo.get(channel)! + 1);
    if (m) {
      if (metaImported) row.importMeta!++;
      else if (m.status === "skipped-out-of-window") row.metaForaDaJanela!++;
      else if (m.status === "skipped-other-channel") row.metaOutroCanal!++;
      else if (m.status === "skipped-failed-permanent") row.metaFalhaPermanente!++;
    }
  }

  for (const row of rows.values()) {
    row.taxaConfirmacao = ratio(row.confirmados, row.cadastros);
    const own = row.channel === "google" ? row.importGoogle : row.channel === "meta" ? row.importMeta : null;
    if (own === null) continue;
    const ativos = importCanalAtivo.get(row.channel)!;
    row.importCanalNaoAtivo = own - ativos;
    row.coberturaImportCanal = ratio(ativos, row.confirmados);
  }

  return {
    since: input.since,
    until: input.until,
    rows: channels.map((c) => rows.get(c)!),
    confirmadaPageviews: input.ga4,
    sourceNotes: [...(input.sourceNotes ?? [])],
  };
}

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}
function num(v: number | null): string {
  return v === null ? "n/d" : String(v);
}

const LABEL: Record<Phase2Channel, string> = { google: "Google", meta: "Meta", outros: "Outros/orgânico" };

/** Texto pro terminal/relatório. @pure */
export function renderPhase2ReportText(r: Phase2Report): string {
  const lines: string[] = [];
  lines.push(`Fase 2 da #8543: cadastro × /confirmada × import × confirmados (cadastros de ${r.since} a ${r.until}, dia BRT)`);
  lines.push("Somente leitura. A decisão da fase 3 (meta primária, CPA-alvo, teto) é do editor.");
  lines.push("");
  lines.push("canal | cadastros | só por click id | confirmados | taxa | pendentes | saíram | import Google | import Meta | cobertura do import do canal");
  for (const row of r.rows) {
    lines.push(
      [
        LABEL[row.channel],
        row.cadastros,
        row.viaClickIdOnly,
        row.confirmados,
        pct(row.taxaConfirmacao),
        row.pendentes,
        row.saiu,
        num(row.importGoogle),
        num(row.importMeta),
        pct(row.coberturaImportCanal),
      ].join(" | "),
    );
  }
  lines.push("");
  const meta = r.rows.find((x) => x.channel === "meta")!;
  if (meta.metaForaDaJanela !== null) {
    lines.push(
      `Meta, perdas do lote no canal Meta: ${meta.metaForaDaJanela} fora da janela de 7 dias, ` +
        `${meta.metaOutroCanal} pulados como de outro canal, ` +
        `${meta.metaFalhaPermanente} recusa permanente.`,
    );
  }
  for (const row of r.rows) {
    if (row.importCanalNaoAtivo) {
      lines.push(
        `${LABEL[row.channel]}: ${row.importCanalNaoAtivo} importado(s) pelo lote do canal que não estão ativos hoje ` +
          "(fora da cobertura, que conta só importado E confirmado).",
      );
    }
  }
  if (r.confirmadaPageviews) {
    const p = r.confirmadaPageviews;
    lines.push(
      `Pageviews de /confirmada (GA4, total sem quebra por canal, janela de ${p.windowDays ?? "?"} dias do cache` +
        `${p.fetchedAt ? `, coletado em ${p.fetchedAt}` : ""}): ${p.pageviews}. ` +
        "A janela do GA4 não é a mesma dos cadastros acima; compare a ordem de grandeza, não o número.",
    );
  } else {
    lines.push("Pageviews de /confirmada: indisponível (cache do GA4 ausente ou sem a página).");
  }
  if (r.sourceNotes.length > 0) {
    lines.push("");
    lines.push("Fontes indisponíveis ou parciais:");
    for (const n of r.sourceNotes) lines.push(`- ${n}`);
  }
  return lines.join("\n") + "\n";
}
