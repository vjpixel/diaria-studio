#!/usr/bin/env node
/**
 * probe-cf-zone-analytics.ts (#5247)
 *
 * Sonda ÚNICA (não é uma task agendada, não escreve dado nenhum em
 * `data/`) se o dataset de ZONA `httpRequestsAdaptiveGroups` da Cloudflare
 * GraphQL Analytics API está disponível pra este token — ANTES de construir
 * `scripts/pull-cf-analytics.ts` (que dependeria dele pra medir tráfego web
 * dos Workers de curadoria: `arquivo`, os hubs, `livros`, `artigos`,
 * `cursos`, `/confirmado`).
 *
 * ## Por que sondar antes de construir
 *
 * O projeto já tentou a GraphQL Analytics API em nível de **Worker**
 * (`workersInvocationsAdaptiveGroups`) e o campo não existe no schema
 * exposto a esta conta — confirmado ao vivo com credenciais reais (#4382,
 * ver `scripts/lib/cursos-error-alarm.ts` §"#4382: por que este módulo
 * mudou..."). O dataset de **zona** (`httpRequestsAdaptiveGroups`) é
 * DIFERENTE — este script sonda se ele corre a mesma sorte antes de gastar
 * esforço num pull script que pode nascer morto pelo mesmo motivo.
 *
 * Distingue os dois jeitos de falhar (mesmo padrão de diagnóstico do
 * `check-cloudflare-token.ts`, #2286):
 *
 *   - **HTTP 400** com erro de schema ("Cannot query field...") → o campo
 *     genuinamente NÃO existe pra esta conta (indisponibilidade real,
 *     mesma classe do #4382 — não adianta trocar o token).
 *   - **HTTP 403** → falta de PERMISSÃO — o token provavelmente não tem o
 *     escopo `Analytics:Read`. Registrar como achado; NUNCA tentar mudar o
 *     token aqui (ação do editor, fora do escopo deste script).
 *   - **HTTP 200 com dado** → disponível — só então vale construir
 *     `scripts/pull-cf-analytics.ts`.
 *
 * ## Ressalva de escopo
 *
 * O apex `diar.ia.br` NÃO está nesta zona Cloudflare (é custom hostname da
 * Beehiiv, gerenciado pela plataforma deles) — só os SUBDOMÍNIOS servidos
 * por Worker (arquivo.diar.ia.br, os hubs, livros.diar.ia.br, etc.) entram
 * na sondagem. A ZONA `diar.ia.br` em si (entidade Cloudflare que gerencia
 * DNS) continua existindo e cobrindo esses subdomínios mesmo com o apex
 * apontando pra fora — é essa zona que este script resolve via
 * `GET /zones?name=diar.ia.br`.
 *
 * ## Resultado desta sessão (registrar aqui pra a próxima não repetir)
 *
 * **RODOU AO VIVO em 22/08/2026 (#5920): `status: "available"`** — HTTP 200
 * com dado, zona `diar.ia.br` (`0c1a216dee80404257ce225a18fae896`). O
 * dataset de ZONA NÃO corre a sorte do `workersInvocationsAdaptiveGroups`
 * do #4382: ele existe pra esta conta.
 *
 * **A ressalva que a sonda sozinha não mostra, e que decide se vale
 * construir o `pull-cf-analytics.ts`:** "dataset disponível" ≠ "toda
 * dimensão disponível". A autorização é POR CAMPO, e as duas dimensões de
 * REFERRER — que eram a razão principal de querer este dataset — são
 * negadas neste plano, com erro `authz` (não erro de schema):
 *
 *   clientRefererHost    → "zone ... does not have access to the field"
 *   clientRequestReferer → idem
 *
 * Mesma negativa em `clientAsn`, `clientASNDescription`,
 * `clientRequestQuery` e `botManagementDecision`. Liberadas e úteis:
 * `clientIP`, `datetime` (segundo a segundo), `clientRequestPath`,
 * `userAgent`, `clientCountryName`, `clientDeviceType`, `edgeResponseStatus`,
 * `verifiedBotCategory`, `requestSource`.
 *
 * Consequência prática, medida no mesmo dia: dá pra reconstruir a SESSÃO de
 * um visitante pela zona inteira (mesmo `clientIP` saltando de host em host,
 * ordenado por `datetime`), mas a ORIGEM externa dele só sai dos Workers
 * Logs — ver #5920, que liga observability nos Workers que ainda não têm.
 *
 * Uso:
 *   npx tsx scripts/probe-cf-zone-analytics.ts [--zone diar.ia.br]
 *
 * Exit code: SEMPRE 0 — é uma sonda de diagnóstico, nunca falha o caller
 * (mesmo espírito de `check-cloudflare-token.ts`: token ausente/inválido é
 * informação, não erro de processo). O resultado estruturado vai pro
 * stdout (JSON); leia `status` pra decidir o próximo passo.
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
import { isMainModule, getArg } from "./lib/cli-args.ts";

const CF_ZONES_URL = "https://api.cloudflare.com/client/v4/zones";
const CF_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const DEFAULT_ZONE_NAME = "diar.ia.br";
const LOG_PREFIX = "[probe-cf-zone-analytics]";

export type CfZoneAnalyticsProbeStatus =
  | "missing_token"
  | "zone_not_found"
  | "forbidden_scope"
  | "unavailable_schema"
  | "available"
  | "error";

export interface CfZoneAnalyticsProbeResult {
  status: CfZoneAnalyticsProbeStatus;
  httpStatus?: number;
  detail: string;
}

/** Resolve o `zone_id` a partir do nome da zona (`GET /zones?name=...`).
 *  Distingue 403 (sem permissão de LISTAR zonas — token com escopo restrito
 *  a um recurso específico) de "zona não encontrada" (200 com `result: []`,
 *  ex: nome errado). */
export async function resolveZoneId(
  zoneName: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ zoneId: string | null; httpStatus: number | null; error: string | null }> {
  try {
    const res = await fetchFn(`${CF_ZONES_URL}?name=${encodeURIComponent(zoneName)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      return { zoneId: null, httpStatus: res.status, error: `GET /zones?name=${zoneName} retornou HTTP ${res.status}: ${bodyText.slice(0, 300)}` };
    }
    let json: { result?: { id?: string }[] } = {};
    try {
      json = JSON.parse(bodyText);
    } catch {
      return { zoneId: null, httpStatus: res.status, error: `resposta não-JSON de /zones: ${bodyText.slice(0, 200)}` };
    }
    const zoneId = json.result?.[0]?.id ?? null;
    return {
      zoneId,
      httpStatus: res.status,
      error: zoneId ? null : `nenhuma zona encontrada com name=${zoneName} (token válido, mas zona ausente/sem acesso).`,
    };
  } catch (e) {
    return { zoneId: null, httpStatus: null, error: `erro de rede/timeout ao resolver zone_id: ${(e as Error).message}` };
  }
}

/** Query GraphQL MÍNIMA — sem sub-seleção de `logs{}`, só pra checar se o
 *  campo `httpRequestsAdaptiveGroups` existe no schema exposto a esta
 *  conta (mesmo racional do #4382: uma query mínima já é suficiente pra
 *  distinguir "campo inexistente" de "existe mas sem permissão"). Janela
 *  de 24h — não importa o dado em si, só se a chamada é aceita. */
export function buildProbeQuery(
  zoneTag: string,
  sinceISO: string,
  untilISO: string,
): { query: string; variables: Record<string, unknown> } {
  return {
    query: `
      query ProbeHttpRequestsAdaptiveGroups($zoneTag: String!, $since: Time!, $until: Time!) {
        viewer {
          zones(filter: { zoneTag: $zoneTag }) {
            httpRequestsAdaptiveGroups(limit: 1, filter: { datetime_geq: $since, datetime_leq: $until }) {
              count
              dimensions { clientRequestHTTPHost }
            }
          }
        }
      }
    `,
    variables: { zoneTag, since: sinceISO, until: untilISO },
  };
}

/** Roda a query mínima e classifica a resposta em `CfZoneAnalyticsProbeStatus`. */
export async function probeHttpRequestsAdaptiveGroups(
  zoneId: string,
  token: string,
  fetchFn: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<CfZoneAnalyticsProbeResult> {
  const until = now.toISOString();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { query, variables } = buildProbeQuery(zoneId, since, until);

  let res: Response;
  let bodyText: string;
  try {
    res = await fetchFn(CF_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
    bodyText = await res.text();
  } catch (e) {
    return { status: "error", detail: `erro de rede/timeout na chamada GraphQL: ${(e as Error).message}` };
  }

  let json: { errors?: { message?: string }[]; data?: unknown } = {};
  try {
    json = JSON.parse(bodyText);
  } catch {
    // corpo não-JSON — segue com json={} e deixa o status HTTP decidir abaixo.
  }

  if (res.status === 403) {
    return {
      status: "forbidden_scope",
      httpStatus: 403,
      detail:
        `HTTP 403 — provável falta do escopo "Analytics:Read" no token (não é indisponibilidade do dataset). ` +
        `Body: ${bodyText.slice(0, 300)}`,
    };
  }

  if (res.status === 400) {
    const errors = json.errors ?? [];
    const looksLikeUnknownField = errors.some((e) =>
      /cannot query field|unknown field|httprequestsadaptivegroups/i.test(String(e?.message ?? "")),
    );
    return {
      status: "unavailable_schema",
      httpStatus: 400,
      detail: looksLikeUnknownField
        ? `HTTP 400 com erro de schema — "httpRequestsAdaptiveGroups" não existe no schema exposto a esta conta ` +
          `(mesma classe do #4382 pro dataset de Worker). Erros: ${JSON.stringify(errors)}`
        : `HTTP 400 sem confirmação clara de "unknown field" — inspecionar manualmente. Body: ${bodyText.slice(0, 500)}`,
    };
  }

  if (!res.ok) {
    return { status: "error", httpStatus: res.status, detail: `HTTP ${res.status} inesperado. Body: ${bodyText.slice(0, 300)}` };
  }

  if (json.errors && json.errors.length > 0) {
    return {
      status: "error",
      httpStatus: res.status,
      detail: `HTTP 200 mas com "errors" no payload GraphQL (anomalia — não é o padrão 400/403 esperado): ${JSON.stringify(json.errors)}`,
    };
  }

  return {
    status: "available",
    httpStatus: res.status,
    detail: "httpRequestsAdaptiveGroups respondeu com sucesso — dataset de zona disponível pra este token.",
  };
}

async function main(): Promise<void> {
  loadProjectEnv();
  const argv = process.argv.slice(2);
  const zoneName = getArg(argv, "zone") || DEFAULT_ZONE_NAME;

  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!token) {
    const result: CfZoneAnalyticsProbeResult = {
      status: "missing_token",
      detail:
        "CLOUDFLARE_API_TOKEN não definida neste ambiente — sondagem não pôde rodar (não é bloqueio, é ambiente: " +
        "rode de novo numa sessão com o token disponível, ex: `npm run sync-env` via Doppler ou .env preenchido).",
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { zoneId, httpStatus: zoneHttpStatus, error: zoneError } = await resolveZoneId(zoneName, token);
  if (!zoneId) {
    const result: CfZoneAnalyticsProbeResult = {
      status: zoneHttpStatus === 403 ? "forbidden_scope" : "zone_not_found",
      httpStatus: zoneHttpStatus ?? undefined,
      detail: zoneError ?? `não foi possível resolver zone_id pra "${zoneName}".`,
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(`${LOG_PREFIX} zone_id resolvido pra "${zoneName}": ${zoneId}. Sondando httpRequestsAdaptiveGroups...`);
  const result = await probeHttpRequestsAdaptiveGroups(zoneId, token);
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    // Sonda nunca falha o processo (ver docstring — exit 0 sempre) — mesmo
    // um erro inesperado aqui é diagnóstico, não motivo pra sair != 0.
    console.error(`${LOG_PREFIX} erro inesperado:`, e);
    console.log(JSON.stringify({ status: "error", detail: `exceção não tratada: ${(e as Error).message}` }, null, 2));
  });
}
