/**
 * scripts/lib/google-ads-ingest.ts (#5237)
 *
 * Traduz o resultado bruto de uma query GAQL (`metrics.cost_micros` por
 * `segments.date`) para o formato `spend.csv` de #5236 (`canal,mes,moeda,
 * valor,fonte`). Núcleo puro/testável — sem I/O de rede nem disco; o
 * orquestrador injetável (`runGoogleAdsIngest`) abaixo é quem decide o que
 * fazer com falha de rede/auth (fail-soft, item 5 do checklist da issue), e
 * o CLI (`scripts/google-ads-ingest-spend.ts`) é quem faz de fato a chamada
 * e escreve em disco.
 *
 * ## Por que fail-soft é o comportamento CORRETO aqui, não um fallback pobre
 *
 * **Atualização 19/08/2026: o Basic Access foi aprovado** (e-mail do Google,
 * 02:16 UTC) — `DEVELOPER_TOKEN_NOT_APPROVED` deixou de ser o estado normal
 * do dia a dia. Validado ao vivo na mesma data: `googleAds:search` contra a
 * conta de produção (`236-921-9639`) devolve 200 (zero linhas — a conta está
 * pausada desde fevereiro, `empty` legítimo). O fail-soft continua sendo o
 * comportamento CORRETO mesmo assim — rede cai, quota estoura, o token pode
 * ser revogado de novo — só que `auth-pending` volta a ser exceção, não
 * regra; ver `fetchGoogleAdsSpendRows` para o achado de MCC↔conta que
 * também apareceu nesta validação.
 *
 * ## Adaptador de `spend-ingest.ts` (#5502 Parte B)
 *
 * A orquestração genérica (fetch → merge, sempre fail-soft) mora em
 * `scripts/lib/spend-ingest.ts` (`runSpendIngest`/`mergeSpendRows`) — este
 * módulo é o ADAPTADOR Google: implementa a autenticação OAuth2 + a query
 * GAQL + a normalização `GaqlSpendApiRow[] → SpendRow[]`, e delega o
 * merge pra `runSpendIngest`. `mergeSpendRows` continua re-exportado
 * DAQUI (não só de `spend-ingest.ts`) pra não quebrar callers/testes
 * existentes que importam do path antigo — é o mesmo símbolo, uma única
 * implementação.
 */

import type { SpendRow } from "./aquisicao-spend.ts";
import { runSpendIngest, mergeSpendRows, type SpendIngestFetchResult } from "./spend-ingest.ts";

export { mergeSpendRows };

// ---------------------------------------------------------------------------
// Parsing GAQL → SpendRow (puro)
// ---------------------------------------------------------------------------

/** Forma mínima de uma linha devolvida por `googleAds:search`/`searchStream`
 *  para a query `SELECT segments.date, metrics.cost_micros FROM customer
 *  WHERE segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'` (ver
 *  `buildDefaultGaqlQuery` — `DURING LAST_90_DAYS` não é literal GAQL válido,
 *  #5237/#5591). `costMicros` pode vir como string (a API serializa int64
 *  como string em JSON) ou number — aceitar os dois evita um bug de parsing
 *  silencioso se o formato mudar entre versões da API. */
export interface GaqlSpendApiRow {
  segments?: { date?: string };
  metrics?: { costMicros?: string | number };
}

export interface AggregateGaqlSpendOptions {
  canal: string;
  moeda: string;
  /** Prefixo da coluna `fonte` — a função acrescenta o range de datas agregado. */
  fonteLabel: string;
}

export interface AggregateGaqlSpendResult {
  rows: SpendRow[];
  /** Nº de linhas de `rows` (o parâmetro, GAQL bruto) descartadas por
   *  malformação durante a agregação — sem `segments.date` válido ou sem
   *  `metrics.costMicros` parseável (#5598). Perda TOTAL do mês
   *  (`aggregatedRows` fica vazio com `rows.length > 0`) já vira `defect` em
   *  `runGoogleAdsIngest`; este campo é o que torna visível a perda PARCIAL
   *  — um schema drift que afeta só uma fração das linhas (ex: metade dos
   *  dias com um campo renomeado) não zera o agregado, então passava
   *  despercebido antes: `spend.csv` saía atualizado, só que SUBESTIMADO. */
  discardedCount: number;
}

/**
 * Núcleo de `aggregateGaqlSpendByMonth` — agrupa linhas GAQL por mês
 * (`AAAA-MM` extraído de `segments.date`, formato `AAAA-MM-DD` da API)
 * somando `cost_micros` (unidade de 1/1.000.000 da moeda da conta) e
 * convertendo para a unidade decimal que `spend.csv` espera. Linhas sem
 * `segments.date` ou `metrics.costMicros` parseável são ignoradas (não têm
 * mês pra agrupar) — nunca contaminam a soma como 0 — e contadas em
 * `discardedCount` (#5598), pra que a perda fique visível a quem chama em
 * vez de só um `spend.csv` menor sem explicação.
 *
 * @pure
 */
export function aggregateGaqlSpendByMonthWithDiscards(
  rows: GaqlSpendApiRow[],
  opts: AggregateGaqlSpendOptions,
): AggregateGaqlSpendResult {
  const byMonth = new Map<string, { microsSum: number; dates: string[] }>();
  let discardedCount = 0;

  for (const row of rows) {
    const date = row.segments?.date;
    const microsRaw = row.metrics?.costMicros;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || microsRaw === undefined) {
      discardedCount++;
      continue;
    }

    const micros = typeof microsRaw === "string" ? Number(microsRaw) : microsRaw;
    if (!Number.isFinite(micros)) {
      discardedCount++;
      continue;
    }

    const mes = date.slice(0, 7);
    const entry = byMonth.get(mes) ?? { microsSum: 0, dates: [] };
    entry.microsSum += micros;
    entry.dates.push(date);
    byMonth.set(mes, entry);
  }

  const aggregatedRows = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, { microsSum, dates }]) => {
      const first = dates.slice().sort()[0];
      const last = dates.slice().sort().at(-1);
      const range = first === last ? first : `${first}..${last}`;
      return {
        canal: opts.canal,
        mes,
        moeda: opts.moeda,
        valor: Math.round((microsSum / 1_000_000) * 100) / 100,
        fonte: `${opts.fonteLabel} — GAQL cost_micros, ${dates.length} dia(s) (${range}), ingestão automática`,
      };
    });

  return { rows: aggregatedRows, discardedCount };
}

/**
 * Atalho de `aggregateGaqlSpendByMonthWithDiscards` pra quem só precisa das
 * linhas agregadas — assinatura preservada de propósito, não quebra
 * callers/testes anteriores ao #5598. Quem precisa saber quantas linhas
 * foram descartadas (`runGoogleAdsIngest`, pra logar perda parcial) usa a
 * variante `WithDiscards` acima diretamente.
 *
 * @pure
 */
export function aggregateGaqlSpendByMonth(
  rows: GaqlSpendApiRow[],
  opts: AggregateGaqlSpendOptions,
): SpendRow[] {
  return aggregateGaqlSpendByMonthWithDiscards(rows, opts).rows;
}

// ---------------------------------------------------------------------------
// Orquestração injetável (fetch + fail-soft) — sem I/O de disco
// ---------------------------------------------------------------------------

export interface GoogleAdsAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  developerToken: string;
  loginCustomerId: string;
  customerId: string;
  apiVersion?: string;
}

export type GoogleAdsIngestResult =
  | { kind: "updated"; rows: SpendRow[]; fetchedRows: number; discardedCount: number }
  | { kind: "fallback"; reason: string; failureClass: GoogleAdsFailureClass };

/** Subconjunto de `fetch` usado — permite injetar um mock em teste sem
 *  depender do `fetch` global do runtime. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_API_VERSION = "v25";

/**
 * Renova o access token via refresh token. Nunca lança — falha de rede,
 * credencial ausente/expirada, ou resposta não-JSON viram `null` +
 * `reason`, porque este caminho é fail-soft por design (item 5 da issue
 * #5237): MCP/API indisponível nunca pode derrubar quem chama.
 */
export async function refreshGoogleAdsAccessToken(
  fetchImpl: FetchLike,
  auth: Pick<GoogleAdsAuthConfig, "clientId" | "clientSecret" | "refreshToken">,
): Promise<{ accessToken: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        refresh_token: auth.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
  } catch (e) {
    return { error: `falha de rede na renovação do access token: ${e instanceof Error ? e.message : e}` };
  }

  const text = await res.text();
  let payload: { access_token?: string; error?: string; error_description?: string };
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: `renovação do access token respondeu não-JSON (HTTP ${res.status})` };
  }
  if (!res.ok || !payload.access_token) {
    // payload.error carrega o código máquina-legível do OAuth2 (RFC 6749 §5.2,
    // ex: "invalid_grant") — é ele que `classifyGoogleAdsFailure` casa contra
    // DEFECT_MARKERS. payload.error_description é só o texto humano; incluir
    // só ele (achado do review do PR #5591, 2ª rodada) faz um refresh token
    // revogado nunca classificar como `defect` — cai no default `transient`
    // e o CLI recomenda paciência pra uma credencial permanentemente quebrada.
    const detail = [payload.error, payload.error_description].filter(Boolean).join(": ") || String(res.status);
    return { error: `renovação do access token falhou: ${detail}` };
  }
  return { accessToken: payload.access_token };
}

/**
 * Busca as linhas GAQL de custo diário da conta. Nunca lança — mesma
 * disciplina fail-soft de `refreshGoogleAdsAccessToken`. Todo HTTP não-2xx
 * (inclusive `DEVELOPER_TOKEN_NOT_APPROVED`, estado esperado hoje, ver
 * docstring do módulo) vira `{ error, failureClass }` — `classifyGoogleAdsFailure`
 * distingue defeito real (query malformada, versão descontinuada) de estado
 * externo esperado (Basic Access na fila) — diferente de
 * `google-ads-associate.ts`, este caminho não tenta classificar "associou
 * ou não", só decide "consegui os dados ou preciso cair pro CSV manual".
 */
export async function fetchGoogleAdsSpendRows(
  fetchImpl: FetchLike,
  auth: GoogleAdsAuthConfig,
  accessToken: string,
  gaqlQuery: string,
): Promise<{ rows: GaqlSpendApiRow[] } | { error: string; failureClass?: GoogleAdsFailureClass }> {
  const apiVersion = auth.apiVersion ?? DEFAULT_API_VERSION;
  const customerId = auth.customerId.replace(/[^0-9]/g, "");
  const configuredLoginCustomerId = auth.loginCustomerId.replace(/[^0-9]/g, "");
  const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`;

  const search = async (loginCustomerId: string): Promise<{ res: Response; text: string } | { networkError: string }> => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": auth.developerToken,
          "login-customer-id": loginCustomerId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: gaqlQuery }),
      });
    } catch (e) {
      return { networkError: `falha de rede na chamada googleAds:search: ${e instanceof Error ? e.message : e}` };
    }
    return { res, text: await res.text() };
  };

  let attempt = await search(configuredLoginCustomerId);
  if ("networkError" in attempt) return { error: attempt.networkError };

  // Achado ao vivo 19/08/2026, mesmo dia da aprovação do Basic Access
  // (#5237): com `login-customer-id` = MCC configurada
  // (`GOOGLE_ADS_LOGIN_CUSTOMER_ID`), a conta de anunciante devolve 403
  // `USER_PERMISSION_DENIED` — mas a MESMA query, na MESMA conta, com
  // `login-customer-id` = a própria conta anunciante (`customerId`), devolve
  // 200. `listAccessibleCustomers` também 200 pros dois IDs. Ou seja: o
  // usuário OAuth tem acesso direto à conta de anúncio, mas não através da
  // hierarquia da MCC configurada — sintoma de vínculo MCC↔conta incompleto
  // no lado do Google Ads (aceitar convite / vínculo de gerenciamento), não
  // de credencial errada nem de Basic Access ainda pendente. Retry único com
  // a própria conta como login-customer-id resolve sem exigir reconfiguração
  // — só dispara quando o 1º corpo bate USER_PERMISSION_DENIED E o login
  // configurado difere da conta-alvo, então nunca mascara outra classe de
  // 403 (ex: DEVELOPER_TOKEN_NOT_APPROVED, que continua indo pro fallback
  // normal sem retry).
  if (
    attempt.res.status === 403 &&
    attempt.text.includes("USER_PERMISSION_DENIED") &&
    configuredLoginCustomerId !== customerId
  ) {
    const retry = await search(customerId);
    if (!("networkError" in retry)) attempt = retry;
  }

  const { res, text } = attempt;
  if (!res.ok) {
    // 600, não 300: com 300 o `errorCode` da GoogleAdsFailure ficava CORTADO
    // (ele vem depois de `@type`/`details`), e foi por isso que o
    // `INVALID_VALUE_WITH_DURING_OPERATOR` acima passou despercebido no
    // #5380 — a mensagem de fallback dizia só "HTTP 400" sem o motivo.
    return {
      error: `googleAds:search respondeu HTTP ${res.status}: ${text.slice(0, 600)}`,
      failureClass: classifyGoogleAdsFailure(text),
    };
  }

  let payload: { results?: GaqlSpendApiRow[] };
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: `googleAds:search respondeu corpo não-JSON (HTTP ${res.status})` };
  }
  return { rows: payload.results ?? [] };
}

export interface RunGoogleAdsIngestOptions {
  auth: GoogleAdsAuthConfig;
  existingRows: SpendRow[];
  canal?: string;
  moeda?: string;
  fonteLabel?: string;
  gaqlQuery?: string;
  /** Relógio injetável — o range `BETWEEN` da query padrão é derivado daqui.
   *  Default `new Date()`; testes passam uma data fixa. */
  now?: Date;
}

/** Janela padrão da ingestão, em dias (inclusive do dia corrente). */
export const DEFAULT_LOOKBACK_DAYS = 90;

/**
 * `AAAA-MM-DD` em UTC — mesmo formato que `segments.date` devolve.
 *
 * **Limitação aceita:** o `segments.date` do Google Ads é o dia-calendário no
 * fuso DA CONTA, não em UTC. Rodando perto da meia-noite UTC com a conta em
 * BRT (UTC-3), a borda da janela pode escorregar um dia. Não corrigido de
 * propósito: a janela é de 90 dias e a agregação é MENSAL (`spend.csv` tem
 * granularidade de mês), então um dia a mais ou a menos na ponta não muda
 * nenhum valor mensal — exceto na virada de mês, onde o mês anterior seria
 * reescrito na rodada seguinte de qualquer forma, porque a janela o recobre
 * inteiro e o merge é idempotente por (`canal`, `mes`).
 */
function toGaqlDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Monta a query padrão com um range EXPLÍCITO (`BETWEEN`), não um literal
 * de data.
 *
 * **Não trocar por `DURING LAST_90_DAYS`** — esse literal NÃO EXISTE no
 * GAQL, e foi o que a 1ª versão deste módulo (#5380) usou. Verificado ao
 * vivo contra a API em 17/08/2026 (v22 e v25, idêntico):
 *
 *     "queryError": "INVALID_VALUE_WITH_DURING_OPERATOR"
 *     "Invalid date literal supplied for DURING operator: LAST_90_DAYS."
 *
 * O GAQL valida a query ANTES da autorização, então esse 400 chegava mesmo
 * com o developer token ainda em nível de teste — e o fail-soft o absorvia
 * como "API indisponível", exatamente o mascaramento que a issue #5237
 * mandou evitar. A ingestão nunca teria funcionado, nem depois do Basic
 * Access sair da fila. Os literais válidos param em `LAST_30_DAYS`
 * (confirmados ao vivo: `LAST_30_DAYS`/`LAST_14_DAYS`/`LAST_7_DAYS`/
 * `THIS_MONTH`/`LAST_MONTH` passam da validação de query e só então esbarram
 * no 403 de auth), nenhum deles cobre os 90 dias que #5236 quer — por isso
 * `BETWEEN` com datas calculadas, que não depende de literal nenhum.
 *
 * @pure
 */
export function buildDefaultGaqlQuery(now: Date, lookbackDays = DEFAULT_LOOKBACK_DAYS): string {
  const end = new Date(now.getTime());
  const start = new Date(now.getTime() - (lookbackDays - 1) * 24 * 60 * 60 * 1000);
  return (
    "SELECT segments.date, metrics.cost_micros FROM customer " +
    `WHERE segments.date BETWEEN '${toGaqlDate(start)}' AND '${toGaqlDate(end)}'`
  );
}

/**
 * Classe de falha da chamada à API — o que separa "estado esperado, degrada
 * em silêncio" de "bug nosso, precisa gritar".
 *
 * A issue #5237 é explícita nisto: *"o teste do parser precisa distinguir os
 * dois casos, senão o fail-soft mascara bug de verdade"*. Sem a distinção,
 * `DEVELOPER_TOKEN_NOT_APPROVED` (esperado hoje) e
 * `INVALID_VALUE_WITH_DURING_OPERATOR` (defeito que nunca ia sarar sozinho)
 * saíam com a mesma linha de log.
 *
 * - `auth-pending` — o acesso ainda não existe. Estado ESPERADO até o Basic
 *   Access sair da fila (#5262). Degrada quieto pro CSV manual.
 * - `defect` — a requisição está malformada ou a versão da API morreu. Nada
 *   no mundo externo conserta isso; é código nosso. Grita.
 * - `transient` — rede, 5xx, quota. Tentar de novo depois resolve.
 * - `empty` — a chamada FUNCIONOU e a conta não gastou nada no período.
 *   Não é falha nenhuma: a conta está pausada desde fevereiro/2026, então
 *   zero é a resposta correta. A issue #5237 pede esta distinção com todas
 *   as letras — *"Zero não é falha de ingestão... senão o fail-soft mascara
 *   bug de verdade quando a #5524 começar a gastar"*.
 *
 * @pure
 */
export type GoogleAdsFailureClass = "auth-pending" | "defect" | "transient" | "empty";

/** Marcadores de defeito checados ANTES dos de auth: são inequívocos (um
 *  `queryError` nunca convive com um `authorizationError` na mesma resposta,
 *  porque o GAQL valida a query primeiro e aborta ali). */
const DEFECT_MARKERS = [
  "queryError",
  "fieldError",
  "UNSUPPORTED_VERSION",
  "INVALID_DEVELOPER_TOKEN",
  // Credencial quebrada, não credencial na fila: o refresh token foi
  // revogado/expirou e precisa de re-consentimento
  // (`google-ads-associate-token.ts --auth`). Esperar não resolve, então é
  // defeito — não `auth-pending`, que aconselharia paciência pra sempre.
  "OAUTH_TOKEN_INVALID",
  "invalid_grant",
];
const AUTH_PENDING_MARKERS = [
  "DEVELOPER_TOKEN_NOT_APPROVED",
  // Confirmado ao vivo em 19/08/2026 (mesmo dia da aprovação do Basic
  // Access): o caso mais comum de `USER_PERMISSION_DENIED` é vínculo
  // MCC↔conta incompleto, não fila — e `fetchGoogleAdsSpendRows` já retenta
  // automaticamente com `login-customer-id` = a própria conta antes desta
  // classificação entrar em jogo (ver comentário lá). Chega aqui só se o
  // retry TAMBÉM falhar — nesse caso ainda tratamos como `auth-pending`
  // (degrada quieto) em vez de `defect`, porque o vínculo MCC pendente de
  // aceite é uma ação de PLATAFORMA (aceitar convite no Google Ads UI, ver
  // docs/google-ads-api-setup.md), não um bug de código — mas nem sempre foi
  // "aguardar resolve sozinho" como a fila do Basic Access era.
  "USER_PERMISSION_DENIED",
  // NÃO confirmado ao vivo contra a API real (diferente dos dois acima, que
  // têm captura real em docs/google-ads-api-setup.md) — semanticamente pode
  // significar conta suspensa/fechada, um estado tão permanente quanto
  // `invalid_grant`, não "fila do Basic Access". Mantido por precaução com
  // esta ressalva explícita; remover ou mover pra DEFECT_MARKERS se/quando
  // reproduzir ao vivo com significado confirmado (achado do review do PR #5591).
  "CUSTOMER_NOT_ENABLED",
];

/**
 * **Código desconhecido cai em `transient`, não em `defect`** — escolha
 * consciente, com um custo conhecido: um código de erro novo do Google que
 * fosse defeito de verdade seria reportado como indisponibilidade até
 * alguém acrescentá-lo a `DEFECT_MARKERS`, que é o velho mascaramento de
 * volta. O contrário (chamar rede instável de defeito) gritaria DEFEITO em
 * toda queda de rede e treinaria o leitor a ignorar o banner, o que custa
 * mais. Se um código novo aparecer no dia a dia, adicionar à lista.
 *
 * @pure
 */
export function classifyGoogleAdsFailure(body: string): GoogleAdsFailureClass {
  if (DEFECT_MARKERS.some((m) => body.includes(m))) return "defect";
  if (AUTH_PENDING_MARKERS.some((m) => body.includes(m))) return "auth-pending";
  return "transient";
}

/**
 * Orquestra token → GAQL → agregação → merge, sempre fail-soft: qualquer
 * falha em qualquer etapa (env ausente é responsabilidade do CLI checar
 * antes de chamar isto; aqui é rede/auth/API) devolve `{ kind: "fallback",
 * reason }` em vez de lançar — o CLI decide o que logar, mas NUNCA quebra
 * o relatório (`cac-report.ts` segue lendo o `spend.csv` manual intocado).
 *
 * Implementado como adaptador de `runSpendIngest` (#5502 Parte B) — o
 * `fetcher` encapsula token+GAQL+agregação (a parte ESPECÍFICA do Google) e
 * devolve `fetchedCount` = nº de linhas GAQL BRUTAS (não o nº de meses
 * agregados) pra preservar o significado histórico de `fetchedRows` que
 * `test/google-ads-ingest-5237.test.ts` já trava.
 *
 * **Perda PARCIAL de linhas é logada mesmo no caminho de sucesso (#5598).**
 * Perda TOTAL (`rows.length > 0` bruto, agregado vazio) já vira `failureClass:
 * "defect"` acima — mas se só uma fração das linhas do mês vier malformada
 * (ex: schema drift que afeta metade dos dias), o agregado não fica vazio,
 * `runSpendIngest` segue o caminho `"updated"` normalmente, e sem este log o
 * `spend.csv` sai SUBESTIMADO sem nenhum sinal. `discardedCount` vai no
 * retorno (pra quem quiser inspecionar programaticamente) e sai como
 * `console.warn` sempre que `> 0` — sem virar `defect`/exit não-zero: o
 * dado parcial ainda é útil, só precisa ser visível.
 */
export async function runGoogleAdsIngest(
  fetchImpl: FetchLike,
  opts: RunGoogleAdsIngestOptions,
): Promise<GoogleAdsIngestResult> {
  const canal = opts.canal ?? "Google Ads";
  const moeda = opts.moeda ?? "BRL";
  const fonteLabel = opts.fonteLabel ?? "Google Ads API (MCP oficial)";
  const gaqlQuery = opts.gaqlQuery ?? buildDefaultGaqlQuery(opts.now ?? new Date());

  // `runSpendIngest` só carrega `reason: string`; a classe de falha e a
  // contagem de descarte viajam por fora, neste closure, pra não alargar o
  // contrato genérico de `spend-ingest.ts` (que serve Google E Microsoft)
  // por causa de vocabulário/telemetria que é só do Google.
  let failureClass: GoogleAdsFailureClass = "transient";
  let discardedCount = 0;

  const fetcher = async (): Promise<SpendIngestFetchResult> => {
    const tokenResult = await refreshGoogleAdsAccessToken(fetchImpl, opts.auth);
    if ("error" in tokenResult) {
      // Classificar também o erro de refresh: `invalid_grant` (refresh token
      // revogado/expirado) é permanente — esperar nunca conserta — e sair
      // como `transient` fixo faria o CLI aconselhar paciência pra sempre.
      failureClass = classifyGoogleAdsFailure(tokenResult.error);
      return { kind: "error", reason: tokenResult.error };
    }

    const spendResult = await fetchGoogleAdsSpendRows(fetchImpl, opts.auth, tokenResult.accessToken, gaqlQuery);
    if ("error" in spendResult) {
      failureClass = spendResult.failureClass ?? "transient";
      return { kind: "error", reason: spendResult.error };
    }

    // A chamada sucedeu. Um resultado vazio daqui pra frente é gasto zero de
    // verdade, não indisponibilidade — `runSpendIngest` transforma `rows: []`
    // em fallback (não há o que mesclar), e é ESTE marcador que impede o CLI
    // de reportar conta pausada como se fosse falha.
    const aggregated = aggregateGaqlSpendByMonthWithDiscards(spendResult.rows, { canal, moeda, fonteLabel });
    discardedCount = aggregated.discardedCount;

    // ...MAS "vazio" só é legítimo se a API também não mandou nada. Se ela
    // devolveu N>0 linhas e a agregação descartou TODAS, o dado existe e nós
    // é que não conseguimos lê-lo — schema drift (Google renomear
    // `costMicros`/`segments.date`) entra exatamente por aqui, porque
    // `aggregateGaqlSpendByMonthWithDiscards` pula linha malformada em
    // silêncio por design. Chamar isso de "gasto zero" seria o mesmo
    // mascaramento que esta issue mandou eliminar, e pior: silencioso justo
    // quando a #5524 começar a gastar de verdade.
    failureClass = spendResult.rows.length > 0 && aggregated.rows.length === 0 ? "defect" : "empty";
    return { kind: "ok", rows: aggregated.rows, fetchedCount: spendResult.rows.length };
  };

  const result = await runSpendIngest({ fetcher, existingRows: opts.existingRows });
  if (result.kind === "fallback") return { ...result, failureClass };

  // Chegou aqui com `discardedCount > 0` só é possível no caso de perda
  // PARCIAL — perda total já saiu pelo ramo `fallback`/`defect` acima
  // (`aggregated.rows.length === 0`), então este warning nunca duplica o
  // banner "✖ DEFEITO" do CLI.
  if (discardedCount > 0) {
    console.warn(
      `[google-ads-ingest] ${discardedCount} linha(s) GAQL descartada(s) por malformação durante a agregação (#5598) — spend.csv pode sair SUBESTIMADO pro(s) mês(es) afetado(s). Investigar schema drift na API (campo renomeado?) antes de confiar no valor.`,
    );
  }

  return { kind: "updated", rows: result.rows, fetchedRows: result.fetchedCount, discardedCount };
}
