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
 * ## Follow-up pós-#7249: coluna persistida + wiring no caminho DEFAULT
 *
 * A versão original deste módulo (PR #7252) entregava só a REGRA + funções
 * ADITIVAS, sem coluna nova e sem tocar o caminho de produção — de propósito,
 * pra não duplicar o conflito de merge com o #7249 (aberto na época, tocando
 * os mesmos 4 arquivos: `diaria-subscribers-db.ts` + as 3 ingestões). Com o
 * #7249 mergeado, este módulo ganhou `backfillCanonicalEdicaoColumn` (grava
 * `event.edicao_canonica`, coluna adicionada em `diaria-subscribers-db.ts`
 * via `EVENT_MIGRATION_COLUMNS`) e o CLI de `leitor-store.ts` passou a usar
 * o dedup canônico por DEFAULT (sem flag) — ver docstring de `leitor-
 * store.ts`.
 *
 * A coluna é gravada a partir do MESMO cálculo MIN(ts) (nunca por dado novo
 * baixado da API — não precisa reingerir nada), rodado pelo backfill em vez
 * de na hora do `recordEvent` (a heurística só faz sentido depois que TODOS
 * os eventos daquele disparo já foram gravados). As 3 ingestões
 * (`beehiiv-subscribers-ingest.ts`, `kit-subscribers-ingest.ts`,
 * `brevo-subscribers-ingest.ts`) continuam sem saber nada de canônica — cada
 * CLI de ingestão (`scripts/diaria-subscribers-ingest-{beehiiv,kit,brevo}.ts`)
 * roda o backfill como último passo, fail-soft (nunca aborta a ingestão se o
 * backfill falhar).
 *
 * A heurística MIN(ts) é só tão precisa quanto o pressuposto "1 `edicao`
 * nativa = 1 disparo, todos os eventos daquele disparo (delivered/sent
 * primeiro, cliques podem vir dias depois) resolvem pra data de publicação
 * do MENOR ts do grupo" — verdadeiro na prática (a diária publica 1x por
 * dia, por plataforma, com `edicao` estável por disparo), mas é aproximação,
 * não a data de publicação em si. `edicao_canonica` fica `NULL` pra qualquer
 * `(platform, edicao)` sem nenhum `delivered`/`sent` gravado ainda — nunca
 * inventa uma data (mesma disciplina de `resolveCanonicalEdicao`).
 *
 * **Honestidade de escopo (#7458 review, type-design-analyzer):** a coluna
 * `edicao_canonica` está provisionada ANTES de ter consumidor —
 * `summarizeStoreLeitoresCanonicalDedup` (`leitor-store.ts`, o caminho
 * DEFAULT que este PR liga) continua recomputando o mapa em TS via
 * `buildCanonicalEdicaoMapFromEvents`, nunca lê a coluna persistida. Hoje
 * ninguém em `scripts/` lê `edicao_canonica` fora do próprio backfill (a
 * consulta de auditoria do CLI é circular — mede o que acabou de escrever).
 * O propósito declarado (permitir `COUNT(DISTINCT edicao_canonica)` direto
 * em SQL, sem recomputar o mapa em memória) fica pronto pra uso futuro
 * (painel, auditoria ad-hoc), não é usado agora — decisão deliberada de
 * não acoplar este PR a outra mudança, não uma lacuna esquecida.
 *
 * @see https://github.com/vjpixel/diaria-studio/issues/7204
 * @see https://github.com/vjpixel/diaria-studio/issues/7163 (épico)
 */

import type { DatabaseSync } from "node:sqlite";
import { openDiariaSubscribersDb, type Platform } from "./diaria-subscribers-db.ts";

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
    // #7458 review (silent-failure-hunter, alta confiança): `tsToBrtAAMMDD`
    // lança em `ts` malformado — `event.ts` não tem validação de formato em
    // `recordEvent`. Sem o try/catch por-linha, 1 timestamp ruim em QUALQUER
    // grupo abortava a função inteira (`for` sem tratamento), o que
    // `runCanonicalEdicaoBackfillFailSoft` engolia como "erro genérico" —
    // desabilitando o backfill de TODOS os grupos, pra sempre, por causa de
    // 1 linha ruim. Pular só o grupo afetado (logado) preserva o resto.
    try {
      map.set(nativeEdicaoKey(r.platform, r.edicao), tsToBrtAAMMDD(r.min_ts));
    } catch (e) {
      console.error(
        `[edicao-canonica] grupo ${r.platform}::${r.edicao} pulado — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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

// ---------------------------------------------------------------------------
// Backfill da coluna persistida `event.edicao_canonica` (#7204, follow-up
// pós-#7249) — grava no schema a mesma chave que `buildCanonicalEdicaoMapFromEvents`
// já sabia calcular, pra habilitar `COUNT(DISTINCT edicao_canonica)` direto
// em SQL (painel, auditoria ad-hoc) sem depender de recomputar o mapa em TS
// toda vez.
// ---------------------------------------------------------------------------

export interface CanonicalEdicaoBackfillResult {
  /** Pares `(platform, edicao)` distintos resolvidos pelo mapa canônico
   *  (ao menos 1 evento `delivered`/`sent` gravado). */
  groupsResolved: number;
  /** Linhas de `event` cujo `edicao_canonica` foi gravado/corrigido nesta
   *  passada — 0 numa 2ª execução sem dado novo (idempotente). */
  rowsUpdated: number;
}

/**
 * Wrapper fail-soft de `backfillCanonicalEdicaoColumn`, pensado pra rodar
 * como ÚLTIMO passo de cada CLI de ingestão (`diaria-subscribers-ingest-
 * {beehiiv,kit,brevo}.ts`) — abre o `.db` já ingerido, roda o backfill,
 * fecha. Nunca lança: um erro aqui (disco cheio, `.db` bloqueado por sync)
 * não deve derrubar uma ingestão que já terminou com sucesso — `edicao_canonica`
 * desatualizada é `NULL`/estale até a PRÓXIMA ingestão rodar (ou o backfill
 * standalone, `scripts/diaria-subscribers-backfill-edicao-canonica.ts`),
 * nunca perda de dado. Retorna `null` em erro (chamador loga o motivo).
 */
export function runCanonicalEdicaoBackfillFailSoft(dbPath: string): CanonicalEdicaoBackfillResult | null {
  try {
    const db = openDiariaSubscribersDb(dbPath);
    try {
      return backfillCanonicalEdicaoColumn(db);
    } finally {
      db.close();
    }
  } catch (e) {
    // #7458 review (silent-failure-hunter, alta confiança): antes o catch
    // era mudo — o docstring prometia "chamador loga o motivo", mas nenhum
    // dos 3 call sites (ingest-{beehiiv,kit,brevo}.ts) checava/logava o
    // `null`. Um `ts` malformado em qualquer evento do store (nenhuma
    // validação de formato em `recordEvent`) já basta pra `tsToBrtAAMMDD`
    // lançar e desabilitar o backfill inteiro, pra sempre, em toda rodada
    // futura, sem NENHUM sinal — exatamente a classe de erro silencioso que
    // este projeto trata como P0/P1. `console.error` aqui não muda o
    // fail-soft (a ingestão segue), só para de ser silencioso.
    console.error(
      `[canonical-edicao-backfill] falhou (ingestão prossegue sem atualizar edicao_canonica): ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/**
 * Popula `event.edicao_canonica` pra TODO evento cujo `(platform, edicao)`
 * o mapa canônico resolve — não só `delivered`/`sent` (a fonte do MIN(ts)),
 * mas TAMBÉM `open`/`click`/`bounce`/etc. do MESMO disparo, porque a chave
 * de agregação é por EDIÇÃO, não por tipo de evento (ver docstring do
 * módulo). Nunca inventa canônica pra um par que o mapa não resolve —
 * `edicao_canonica` fica `NULL` nesse caso (consumidor cai no fallback
 * `nativeEdicaoKey`, mesma semântica de `resolveCanonicalEdicao`).
 *
 * Idempotente e seguro rodar repetidamente (a cada ingestão, ou como
 * backfill manual único contra o store real): só regrava quando o valor
 * atual diverge do recém-calculado, então uma 2ª execução sem evento novo
 * grava 0 linhas. NUNCA insere nem apaga linha — só `UPDATE` de 1 coluna,
 * então o guard de conservação (`checkMergeConservation`-like: `COUNT(*)`
 * de `event` antes == depois) é trivialmente satisfeito por construção; o
 * CLI de backfill confirma isso mesmo assim, defensivamente.
 */
export function backfillCanonicalEdicaoColumn(db: DatabaseSync): CanonicalEdicaoBackfillResult {
  const canonicalMap = buildCanonicalEdicaoMapFromEvents(db);
  let rowsUpdated = 0;
  const stmt = db.prepare(
    `UPDATE event SET edicao_canonica = ?
     WHERE platform = ? AND edicao = ? AND (edicao_canonica IS NULL OR edicao_canonica != ?)`,
  );
  for (const [key, aammdd] of canonicalMap) {
    // key = "platform::edicao" (nativeEdicaoKey) — separa de volta. `edicao`
    // nativo nunca contém "::" na prática (ids de post/broadcast/campanha),
    // mas usar indexOf (1ª ocorrência) + slice, em vez de split ingênuo, é
    // defensivo mesmo assim caso isso mude no futuro.
    const sep = key.indexOf("::");
    const platform = key.slice(0, sep);
    const edicaoNativa = key.slice(sep + 2);
    const result = stmt.run(aammdd, platform, edicaoNativa, aammdd);
    rowsUpdated += Number(result.changes);
  }
  return { groupsResolved: canonicalMap.size, rowsUpdated };
}
