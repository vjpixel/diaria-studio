/**
 * clarice-wave-audit.ts (#7880)
 *
 * Lógica PURA (sem I/O) de `scripts/audit-wave-no-duplicate-sends.ts` —
 * responde "algum contato da onda recém-montada já recebeu/vai receber e-mail
 * Clarice/Brevo ao vivo dentro do mês-alvo, por uma via que o STORE LOCAL não
 * enxerga?".
 *
 * Por que isto é diferente das duas camadas já existentes (ver issue):
 *   1. `excludeSentSince`/`resolveRecencyCutoffWithDefault` (clarice-recency.ts,
 *      #7234) — exclui por `last_sent_at` do STORE.
 *   2. `excludeCommittedToQueuedCampaigns` (clarice-segment.ts, #2994/#3682) —
 *      exclui por `brevo_list_ids` do STORE cruzado contra listas
 *      queued/sent buscadas ao vivo, mas só age NA SELEÇÃO (antes do build).
 * As duas leem/escrevem sobre o STORE local. Se o store estiver defasado
 * (sync incremental atrasado, escrita perdida), as duas camadas concordam
 * com a defasagem e não acusam nada — "guard defasado concorda com sujeito
 * defasado" (ver `nao-mutar-o-que-esta-sob-verificacao`/`guard-defasado-
 * concorda-com-sujeito-defasado` na memória do projeto).
 *
 * Este módulo é uma AUDITORIA PÓS-montagem, independente das duas camadas
 * acima — cruza a onda JÁ MONTADA (lida do CSV/store, congelada no momento
 * do build) contra o estado ao vivo da Brevo (`fetchCampaignsByStatus`,
 * `status=sent`/`status=queued`, filtrado por `--month`), sem depender de
 * `last_sent_at` nem de `sent-or-queued.json` estarem corretos.
 *
 * Armadilha documentada na issue (#7880): filtrar só por DATA sem olhar
 * STATUS dá falso positivo — campanhas `suspended`/`draft` "estacionadas"
 * com `scheduledAt` fictício (ex: `2035-01-01`, achado ao vivo) nunca
 * dispararam e não podem contar como colisão. Este módulo nunca recebe
 * campanhas `suspended`/`draft` para começo de conversa — o caller (I/O)
 * só busca `status=sent` e `status=queued` via `fetchCampaignsByStatus`
 * (mesmo padrão de `fetchQueuedCampaignListIds`/`fetchSentCampaignListIds`,
 * brevo-client.ts) — o filtro de status é estrutural, não uma regra a
 * lembrar aqui.
 */

import type { BrevoDraftCampaignRaw } from "./brevo-client.ts";
import { parseBrevoListIds } from "./clarice-segment.ts";

/** Formato aceito por `--month` (ex: "2026-09"). */
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export interface MonthWindow {
  /** ISO, 00:00 UTC do dia 1 do mês (inclusive). */
  startIso: string;
  /** ISO, 00:00 UTC do dia 1 do mês SEGUINTE (exclusive). */
  endIsoExclusive: string;
}

/**
 * Resolve `--month YYYY-MM` pra uma janela [start, end) em ISO/UTC. Lança em
 * formato inválido ou mês fora de 01-12 — mesma disciplina de
 * `resolveNotSentCutoff`/`sendMonthStartIso` (clarice-paths.ts): nunca
 * degrada pra um default silencioso quando o operador passou algo errado.
 */
export function monthWindowIso(month: string): MonthWindow {
  const m = MONTH_RE.exec(month);
  if (!m) {
    throw new Error(`--month inválido: "${month}" — esperado YYYY-MM (ex: 2026-09).`);
  }
  const year = Number(m[1]);
  const monthNum = Number(m[2]);
  if (monthNum < 1 || monthNum > 12) {
    throw new Error(`--month inválido: "${month}" — mês fora de 01-12.`);
  }
  const startIso = new Date(Date.UTC(year, monthNum - 1, 1)).toISOString();
  const endIsoExclusive = new Date(Date.UTC(year, monthNum, 1)).toISOString();
  return { startIso, endIsoExclusive };
}

/** Campanha ao vivo (sent ou queued) que alimenta uma lista em colisão — só o
 *  necessário pra nomear a colisão no relatório. */
export interface LiveCampaignRef {
  id?: number;
  name?: string;
  status?: string;
  /** `sentDate` (status=sent) ou `scheduledAt` (status=queued), o que se aplica. */
  date?: string | null;
}

/**
 * Filtra `campaigns` (já buscadas por UM status — `sent` OU `queued`, nunca
 * `suspended`/`draft`, ver docstring do topo) pra dentro da janela do mês, e
 * indexa por `list_id` → campanhas que a alimentam. `excludeListIds` tira as
 * listas do PRÓPRIO lote sendo auditado (a onda que acabou de ser
 * montada/importada não deve colidir consigo mesma).
 *
 * Campanha sem a data relevante (`sentDate` pra `status="sent"`,
 * `scheduledAt` pra `status="queued"`) é EXCLUÍDA — não dá pra confirmar que
 * está dentro da janela (mesmo racional de `findOverlappingListCampaigns`,
 * clarice-overlap.ts).
 */
export function buildLiveListIndex(
  campaigns: BrevoDraftCampaignRaw[],
  status: "sent" | "queued",
  window: MonthWindow,
  excludeListIds: ReadonlySet<string> = new Set(),
): Map<string, LiveCampaignRef[]> {
  const startMs = Date.parse(window.startIso);
  const endMs = Date.parse(window.endIsoExclusive);
  const dateField: "sentDate" | "scheduledAt" = status === "sent" ? "sentDate" : "scheduledAt";

  const out = new Map<string, LiveCampaignRef[]>();
  for (const c of campaigns) {
    const raw = c[dateField];
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isNaN(t) || t < startMs || t >= endMs) continue;
    for (const listId of c.recipients?.lists ?? []) {
      const key = String(listId);
      if (excludeListIds.has(key)) continue;
      const arr = out.get(key) ?? [];
      arr.push({ id: c.id, name: c.name, status, date: raw });
      out.set(key, arr);
    }
  }
  return out;
}

/**
 * Une dois índices lista→campanhas (tipicamente `sent` + `queued`) sem
 * mutar nenhum dos dois — nova Map, arrays concatenados por chave comum.
 */
export function mergeLiveListIndexes(
  a: ReadonlyMap<string, LiveCampaignRef[]>,
  b: ReadonlyMap<string, LiveCampaignRef[]>,
): Map<string, LiveCampaignRef[]> {
  const out = new Map<string, LiveCampaignRef[]>();
  for (const [key, camps] of a) out.set(key, camps.slice());
  for (const [key, camps] of b) {
    const existing = out.get(key);
    out.set(key, existing ? [...existing, ...camps] : camps.slice());
  }
  return out;
}

/** Contato da onda recém-montada — `email` (do CSV do grupo) + `brevo_list_ids`
 *  cru do store (mesmo shape de `StoreRow`, coluna TEXT/JSON). */
export interface WaveContact {
  email: string;
  brevo_list_ids?: string | null;
}

export interface WaveCollision {
  email: string;
  /** list_ids do contato que colidem com alguma campanha ao vivo no período. */
  listIds: string[];
  /** Campanhas envolvidas (dedup por id, união de todas as listas em colisão). */
  campaigns: LiveCampaignRef[];
}

/**
 * Cruza cada contato da onda contra `liveListIndex` (saída de
 * `buildLiveListIndex`/`mergeLiveListIndexes`) — devolve só quem tem
 * intersecção não-vazia. Puro/determinístico: mesma disciplina de
 * `excludeCommittedToQueuedCampaigns` (clarice-segment.ts), mas reportando em
 * vez de excluir (este é um script de AUDITORIA pós-montagem, não um filtro
 * de seleção).
 */
export function findWaveListCollisions(
  contacts: WaveContact[],
  liveListIndex: ReadonlyMap<string, LiveCampaignRef[]>,
): WaveCollision[] {
  if (liveListIndex.size === 0) return [];
  const out: WaveCollision[] = [];
  for (const contact of contacts) {
    const lists = parseBrevoListIds(contact.brevo_list_ids);
    const matchedLists = lists.filter((id) => liveListIndex.has(id));
    if (matchedLists.length === 0) continue;

    const campaignsById = new Map<string, LiveCampaignRef>();
    for (const listId of matchedLists) {
      for (const camp of liveListIndex.get(listId) ?? []) {
        const key = camp.id != null ? String(camp.id) : `${camp.name ?? "?"}|${camp.date ?? "?"}`;
        if (!campaignsById.has(key)) campaignsById.set(key, camp);
      }
    }
    out.push({ email: contact.email, listIds: matchedLists, campaigns: [...campaignsById.values()] });
  }
  return out;
}
