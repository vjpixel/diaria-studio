/**
 * diaria-subscribers-edicao-canonica.ts (#7163 fatia 9 — #7204)
 *
 * ## O problema
 *
 * `event.edicao` guarda o id NATIVO da plataforma (`post_0067d367-…` na
 * Beehiiv, broadcast id no Kit, campaignId na Brevo). Quando as 3
 * plataformas tiverem dado no store, a MESMA edição do dia entra 3 vezes com
 * 3 chaves diferentes — `COUNT(DISTINCT edicao)` conta a mesma entrega até
 * 3x pra quem existe em mais de 1 plataforma, exatamente quem a resolução de
 * identidade (#6589/#7205) acabou de unificar.
 *
 * ## O que este módulo entrega
 *
 * A chave canônica de edição é `AAMMDD` (mesma identidade editorial de
 * `data/editions/{AAMMDD}/` em todo o resto do projeto). `tsToBrtAAMMDD`
 * converte um timestamp ISO pra essa chave, ajustado pra BRT (mesmo ajuste
 * de `unixSecondsToBrtDate` em `beehiiv-publish-date.ts` — publicação de
 * madrugada não vaza pro dia UTC seguinte).
 *
 * `buildCanonicalEdicaoMapFromEvents` deriva o mapa "id nativo → AAMMDD" A
 * PARTIR DO PRÓPRIO STORE: agrupa `event` por `(platform, edicao)` e usa o
 * MENOR `ts` entre os eventos de entrega (`delivered`/`sent`) de cada grupo
 * como aproximação da data de publicação — sem precisar de tabela de
 * mapeamento nova nem de chamada a API nenhuma.
 *
 * `countDistinctCanonicalEditions` deduplica uma lista de eventos
 * (platform + edicao nativa) pela chave canônica — é o "agregar pela
 * canônica" que fecha a dupla contagem cross-plataforma.
 *
 * ## O que NÃO está feito aqui — e por quê (#7249 em voo)
 *
 * O caminho correto de LONGO prazo é gravar a data de publicação REAL (já
 * baixada da API de cada plataforma na hora da ingestão — Beehiiv
 * `publish_date`, Kit `created_at` do broadcast, Brevo `date_sent` da
 * campanha) numa coluna própria (`event.edicao_canonica`) em vez de
 * recalcular por MIN(ts) toda vez. Isso exigiria tocar `diaria-subscribers-
 * db.ts` (schema) + as 3 ingestões (`beehiiv-subscribers-ingest.ts`,
 * `kit-subscribers-ingest.ts`, `brevo-subscribers-ingest.ts`) — os MESMOS 4
 * arquivos que o PR #7249 (aberto, #7201/#7202) já está tocando. Fazer isso
 * aqui duplicaria o conflito de merge com um PR já em voo sobre o dado real.
 * Este módulo entrega a REGRA (chave canônica + agregação por ela) e as
 * funções ADITIVAS de cross-plataforma (`diaria-subscribers-edicao-canonica
 * .test.ts` prova "hoje conta 2, com a canônica conta 1"), sem tocar o
 * caminho de produção (`leitor-store.ts` `computeStoreLeitorInput`/
 * `summarizeStoreLeitores` continuam usando a soma por-plataforma de
 * sempre) nem os 4 arquivos em conflito. Ligar isto ao caminho de produção —
 * seja via a heurística MIN(ts) daqui, seja via a coluna gravada na
 * ingestão — é follow-up explícito, depois do #7249 mergear.
 *
 * A heurística MIN(ts) é só tão precisa quanto o pressuposto "1 `edicao`
 * nativa = 1 disparo, todos os eventos daquele disparo (delivered/sent
 * primeiro, cliques podem vir dias depois) resolvem pra data de publicação
 * do MENOR ts do grupo" — verdadeiro na prática (a diária publica 1x por
 * dia, por plataforma, com `edicao` estável por disparo), mas é aproximação,
 * não a data de publicação em si.
 *
 * @see https://github.com/vjpixel/diaria-studio/issues/7204
 * @see https://github.com/vjpixel/diaria-studio/issues/7163 (épico)
 */

import type { DatabaseSync } from "node:sqlite";
import type { Platform } from "./diaria-subscribers-db.ts";

/**
 * Timestamp ISO → `AAMMDD` ajustado pra BRT (UTC-3, sem DST) — mesmo ajuste
 * de `unixSecondsToBrtDate` (`beehiiv-publish-date.ts`), só que a partir de
 * um ISO string (o formato que `event.ts` já usa) em vez de Unix seconds.
 */
export function tsToBrtAAMMDD(tsIso: string): string {
  const ms = Date.parse(tsIso);
  if (Number.isNaN(ms)) {
    throw new Error(`tsToBrtAAMMDD: ts inválido: "${tsIso}"`);
  }
  const brt = new Date(ms - 3 * 3600 * 1000).toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  return `${brt.slice(2, 4)}${brt.slice(5, 7)}${brt.slice(8, 10)}`;
}

/** Chave composta plataforma+edição nativa — usada como chave do mapa
 *  canônico e como fallback determinístico quando o mapa não conhece o par
 *  (nunca funde silenciosamente algo que não sabe resolver). */
export function nativeEdicaoKey(platform: Platform, edicaoNativa: string): string {
  return `${platform}::${edicaoNativa}`;
}

/**
 * Constrói o mapa "id nativo → AAMMDD" varrendo o `event` do store: para
 * cada `(platform, edicao)` distinto com ao menos 1 evento `delivered` ou
 * `sent`, usa o MENOR `ts` desse grupo (ver docstring do módulo pro porquê
 * `delivered`/`sent` e não qualquer tipo — um `click` isolado, sem entrega
 * correspondente no store, não tem como aproximar a data de publicação).
 * `edicao` nativa sem NENHUM evento `delivered`/`sent` fica de fora do
 * mapa — `resolveCanonicalEdicao`/`countDistinctCanonicalEditions` caem no
 * fallback por par nativo pra esses casos, nunca inventam uma data.
 */
export function buildCanonicalEdicaoMapFromEvents(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT platform, edicao, MIN(ts) AS min_ts FROM event
       WHERE edicao IS NOT NULL AND edicao != '' AND type IN ('delivered', 'sent')
       GROUP BY platform, edicao`,
    )
    .all() as Array<{ platform: Platform; edicao: string; min_ts: string }>;

  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(nativeEdicaoKey(r.platform, r.edicao), tsToBrtAAMMDD(r.min_ts));
  }
  return map;
}

/** Resolve a chave canônica de um evento — `null` quando `edicaoNativa` é
 *  ausente ou o mapa não conhece o par (nenhum `delivered`/`sent` gravado
 *  pra ele ainda). Caller decide o fallback (ver `countDistinctCanonicalEditions`). */
export function resolveCanonicalEdicao(
  map: Map<string, string>,
  platform: Platform,
  edicaoNativa: string | null | undefined,
): string | null {
  if (!edicaoNativa) return null;
  return map.get(nativeEdicaoKey(platform, edicaoNativa)) ?? null;
}

export interface EdicaoEventEntry {
  platform: Platform;
  edicao: string | null;
  externalEventId: string;
}

/**
 * Deduplica uma lista de eventos (platform + edição nativa) pela chave
 * CANÔNICA — é o "agregar pela canônica" que fecha a dupla contagem
 * cross-plataforma (#7204). Quando o mapa não resolve um par (nenhum
 * `delivered`/`sent` gravado ainda pra aquela edição nativa), cai no
 * fallback `nativeEdicaoKey` — nunca funde por acidente um par que não
 * conseguiu resolver a uma data real.
 */
export function countDistinctCanonicalEditions(
  entries: readonly EdicaoEventEntry[],
  canonicalMap: Map<string, string>,
): number {
  const set = new Set<string>();
  for (const e of entries) {
    const native = e.edicao ?? e.externalEventId;
    const canonical = e.edicao ? canonicalMap.get(nativeEdicaoKey(e.platform, e.edicao)) : undefined;
    set.add(canonical ?? nativeEdicaoKey(e.platform, native));
  }
  return set.size;
}
