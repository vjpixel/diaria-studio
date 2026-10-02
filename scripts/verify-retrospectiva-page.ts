/**
 * scripts/verify-retrospectiva-page.ts (#9474)
 *
 * Canal `pagina` de `/diaria-mensal-apoiadores`: confere que a Retrospectiva
 * do ciclo está NO AR em `retrospectiva.diar.ia.br/{AAMM}` (Worker
 * `workers/retrospectiva`) ANTES do envio do e-mail e dos posts — todos eles
 * apontam (direta ou indiretamente) pra essa página.
 *
 * ## Por que "GET 200" sozinho não prova nada aqui
 *
 * `/AAMM` responde **200 mesmo sem conteúdo publicado**: sem `?email=`, o
 * Worker serve o trecho + paywall quando há `article:{AAMM}:teaser` no KV, e o
 * PAYWALL SECO (também 200) quando não há (`apoioTeaserResponse` em
 * `workers/retrospectiva/src/index.ts`). E `HEAD` cai no 405 (o Worker só
 * aceita GET). Então a verificação tem duas camadas:
 *
 *   1. **Pública (sempre):** `GET` sem e-mail → precisa 200, e o corpo é
 *      classificado: `teaser` (tem o marcador `id="retrospectiva-paywall"`
 *      que só o trecho+paywall injeta, #7720) ou `paywall_seco`.
 *   2. **KV (quando há credencial Cloudflare):** a chave `article:{AAMM}` —
 *      a edição COMPLETA, a que o apoiador paga pra ler — existe no namespace
 *      `ARTICLES`. É a única prova de que o apoiador que entrar com o e-mail
 *      vai ler a edição, e não o 404 "Artigo não encontrado". Nunca testada
 *      via `?email=` real: isso exigiria um e-mail de apoiador numa URL.
 *
 * Veredito:
 *   - `live`: 200 + `article:{AAMM}` no KV (teaser ausente vira AVISO — o
 *     ciclo 2604-05 é anterior à convenção de corte e não tem trecho, #7580).
 *   - `live_unconfirmed`: 200 + teaser, KV NÃO CONSULTADO (sem credencial) —
 *     forte indício, não prova; o script sai 0 mas grava `pagina` como
 *     `done` só com `--accept-teaser` (decisão consciente, logada).
 *   - `not_live`: status ≠ 200 (ou corpo ilegível), KV respondeu que a edição
 *     completa NÃO existe, a leitura do KV FALHOU (403/5xx — nunca confundida
 *     com "sem credencial"), ou paywall seco sem KV pra desempatar.
 *
 * ## Quem publica a página (achado do #9474)
 *
 * NENHUM passo de `/diaria-mensal` nem de `/diaria-mensal-apoiadores` publicava
 * a página até aqui. O mecanismo existe e é só KV (sem deploy de Worker):
 * `npx tsx scripts/build-article-page.ts --cycle {ciclo} --push` grava
 * `article:{AAMM}` + `article:{AAMM}:teaser`. Listar o path em
 * `PATHS_COM_TRECHO` (`workers/retrospectiva/src/index.ts`) só serve ao
 * sitemap e exige deploy (CI no merge) — opcional pra a página funcionar.
 * Este script NUNCA publica: só verifica e aponta o comando.
 *
 * Uso:
 *   npx tsx scripts/verify-retrospectiva-page.ts --cycle 2609-10 [--no-kv] [--accept-teaser] [--no-state]
 *
 * Exit: 0 = live; 1 = not_live (contrato: no preflight do Passo 0 é SINAL de
 * que a página ainda vai ser publicada, não falha do comando); 3 =
 * live_unconfirmed sem `--accept-teaser` (nada gravado); 2 = uso/erro.
 * Grava o canal `pagina` em `data/monthly/{ciclo}/_internal/divulgacao-published.json`
 * e registra no run-log (`--no-state` desliga os dois — preflight read-only).
 */

import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { isMainModule, hasFlag } from "./lib/cli-args.ts";
import { requireMonthlyCycleArg, monthlyDir } from "./lib/mensal/monthly-paths.ts";
import { mensalPathFromCycle } from "./lib/shared/retrospectiva-path.ts";
import { readRetrospectivaNamespaceId } from "./lib/shared/retrospectiva-kv-namespaces.ts";
import { getTextFromWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { buildDoneChannelState, buildFailedChannelState, withChannelState } from "./lib/artigo-especial-state.ts";
import {
  retrospectivaUrl,
  retrospectivaDivulgacaoStatePath,
  readRetrospectivaDivulgacaoState,
  writeRetrospectivaDivulgacaoState,
} from "./lib/mensal/retrospectiva-divulgacao.ts";
import { logEvent } from "./lib/run-log.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** Marcador que só o trecho+paywall injeta (`render-mensal.ts`, #7720). */
const TEASER_MARKER = 'id="retrospectiva-paywall"';

export type PublicPageKind = "teaser" | "paywall_seco";

/** Pura: classifica o corpo da resposta pública (sem e-mail) de `/AAMM`. */
export function classifyPublicBody(html: string): PublicPageKind {
  return html.includes(TEASER_MARKER) ? "teaser" : "paywall_seco";
}

/** `true` = edição completa no KV; `false` = KV respondeu miss; `null` = não consultado/erro. */
export type KvArticleCheck = boolean | null;

export type PageVerdict = "live" | "live_unconfirmed" | "not_live";

export interface PageVerification {
  url: string;
  httpStatus: number | null;
  publicKind: PublicPageKind | null;
  kvArticle: KvArticleCheck;
  kvError: string | null;
  verdict: PageVerdict;
  /** Avisos não-bloqueantes (ex: teaser ausente com artigo completo no KV). */
  warnings: string[];
  /** Motivo legível quando `verdict !== "live"`. */
  reason: string | null;
}

/** Pura: combina as duas camadas num veredito (ver docstring do módulo). */
export function decidePageVerdict(input: {
  httpStatus: number | null;
  publicKind: PublicPageKind | null;
  kvArticle: KvArticleCheck;
  /** Erro do fetch público (rede, timeout, corpo ilegível), quando houve. */
  fetchError?: string | null;
  /** Erro da leitura do KV quando ela FOI tentada (credencial presente). */
  kvError?: string | null;
}): { verdict: PageVerdict; reason: string | null; warnings: string[] } {
  const warnings: string[] = [];
  if (input.httpStatus !== 200 || input.publicKind === null) {
    const what = input.httpStatus === null ? "erro de rede" : `status ${input.httpStatus}`;
    return {
      verdict: "not_live",
      reason:
        input.httpStatus === 200
          ? `GET público devolveu 200, mas o corpo não pôde ser lido${input.fetchError ? ` (${input.fetchError})` : ""}.`
          : `GET público: ${what}${input.fetchError ? ` (${input.fetchError})` : ""} — esperado 200.`,
      warnings,
    };
  }
  // KV TENTADO e com erro (403 de token sem escopo, 5xx, timeout) não é o
  // mesmo que "sem credencial": nunca vira `live_unconfirmed`, senão o
  // `--accept-teaser` aceitaria uma falha real de permissão como se fosse a
  // ausência esperada de credencial (achado do review do PR #9475).
  if (input.kvError) {
    return {
      verdict: "not_live",
      reason: `a leitura do KV ARTICLES falhou (${input.kvError}) — não há como afirmar que a edição completa foi publicada.`,
      warnings,
    };
  }
  if (input.kvArticle === false) {
    return {
      verdict: "not_live",
      reason: "a edição COMPLETA (article:{AAMM}) não existe no KV ARTICLES — o apoiador que entrar com o e-mail cai no 404.",
      warnings,
    };
  }
  if (input.kvArticle === true) {
    if (input.publicKind !== "teaser") {
      warnings.push("edição completa publicada, mas SEM trecho público (paywall seco pra quem não apoia) — rode o build com --push de novo ou aceite (ciclos pré-#7580 não têm onde cortar).");
    }
    return { verdict: "live", reason: null, warnings };
  }
  // KV não consultado: só o corpo público decide.
  if (input.publicKind === "teaser") {
    warnings.push("KV não consultado (sem credencial Cloudflare) — o trecho está no ar, mas a edição completa não foi conferida.");
    return {
      verdict: "live_unconfirmed",
      reason: "edição completa não conferida no KV (sem credencial).",
      warnings,
    };
  }
  return {
    verdict: "not_live",
    reason: "paywall seco (sem trecho) e KV não consultado — não há como afirmar que a edição foi publicada.",
    warnings,
  };
}

export interface VerifyDeps {
  fetchImpl: typeof fetch;
  /** `null` = não consultar o KV (sem credencial / `--no-kv`). */
  readKv: ((key: string) => Promise<string | null>) | null;
}

/** Corpo testável: faz as 2 camadas e devolve o veredito. Nunca lança por rede. */
export async function verifyRetrospectivaPage(cycle: string, deps: VerifyDeps): Promise<PageVerification> {
  const url = retrospectivaUrl(cycle);
  const path = mensalPathFromCycle(cycle)!;

  let httpStatus: number | null = null;
  let publicKind: PublicPageKind | null = null;
  let fetchError: string | null = null;
  try {
    const res = await deps.fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      // UA explícito: curl/fetch sem UA leva challenge da Cloudflare em alguns hosts.
      headers: { "User-Agent": "diaria-studio/verify-retrospectiva-page (+https://diar.ia.br)" },
      signal: AbortSignal.timeout(15000),
    });
    httpStatus = res.status;
    if (res.status === 200) publicKind = classifyPublicBody(await res.text());
  } catch (e) {
    // Mantém o `httpStatus` já recebido (um 200 com corpo ilegível não é
    // "erro de rede") e preserva a causa no motivo.
    fetchError = (e as Error).message;
  }

  let kvArticle: KvArticleCheck = null;
  let kvError: string | null = null;
  if (deps.readKv) {
    try {
      kvArticle = (await deps.readKv(`article:${path}`)) !== null;
    } catch (e) {
      kvError = (e as Error).message;
      kvArticle = null;
    }
  }

  const { verdict, reason, warnings } = decidePageVerdict({ httpStatus, publicKind, kvArticle, fetchError, kvError });
  return { url, httpStatus, publicKind, kvArticle, kvError, verdict, warnings, reason };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cycle = requireMonthlyCycleArg(argv);
  const useKv = !hasFlag(argv, "no-kv");
  const acceptTeaser = hasFlag(argv, "accept-teaser");
  const writeState = !hasFlag(argv, "no-state");

  loadProjectEnv(ROOT);
  const hasCfCreds = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_WORKERS_TOKEN);
  let readKv: VerifyDeps["readKv"] = null;
  if (useKv && hasCfCreds) {
    const kvNamespaceId = readRetrospectivaNamespaceId("ARTICLES");
    readKv = (key) => getTextFromWorkerKV(key, { kvNamespaceId });
  } else if (useKv) {
    console.warn("[verify-retrospectiva-page] AVISO: CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN ausentes — KV não será consultado.");
  }

  const v = await verifyRetrospectivaPage(cycle, { fetchImpl: fetch, readKv });
  console.log(`URL: ${v.url}`);
  console.log(`GET público: ${v.httpStatus ?? "erro de rede"}${v.publicKind ? ` (${v.publicKind})` : ""}`);
  console.log(`KV article:{AAMM}: ${v.kvArticle === null ? "não consultado" : v.kvArticle ? "presente" : "AUSENTE"}`);
  for (const w of v.warnings) console.warn(`AVISO: ${w}`);
  console.log(`Veredito: ${v.verdict}${v.reason ? ` — ${v.reason}` : ""}`);
  if (v.verdict === "not_live") {
    console.error(
      `\nPublicar a página: npx tsx scripts/build-article-page.ts --cycle ${cycle} --push\n` +
        "(grava article:{AAMM} + :teaser no KV ARTICLES do Worker retrospectiva — sem deploy). Depois rode este script de novo.",
    );
  }

  const ok = v.verdict === "live" || (v.verdict === "live_unconfirmed" && acceptTeaser);
  if (writeState) {
    const statePath = retrospectivaDivulgacaoStatePath(monthlyDir(cycle));
    const state = readRetrospectivaDivulgacaoState(statePath, cycle);
    const now = new Date().toISOString();
    if (ok) {
      writeRetrospectivaDivulgacaoState(statePath, withChannelState(state, "pagina", buildDoneChannelState(now, v.url)));
    } else if (v.verdict === "not_live") {
      writeRetrospectivaDivulgacaoState(statePath, withChannelState(state, "pagina", buildFailedChannelState(now, v.reason ?? "não está no ar")));
    }
    // live_unconfirmed sem --accept-teaser: não grava nada (nem done nem failed).
    // `--no-state` (preflight read-only) também não loga: só a execução real
    // do canal entra no run-log.
    logEvent(
      {
        edition: cycle,
        stage: null,
        agent: "verify-retrospectiva-page",
        level: v.verdict === "not_live" ? "warn" : "info",
        message: `retrospectiva ${v.url}: ${v.verdict}`,
        details: { httpStatus: v.httpStatus, publicKind: v.publicKind, kvArticle: v.kvArticle, warnings: v.warnings },
      },
      ROOT,
    );
  }

  if (v.verdict === "live_unconfirmed" && !acceptTeaser) {
    console.warn("Canal `pagina` NÃO gravado: passe --accept-teaser pra aceitar o trecho como prova, ou configure a credencial Cloudflare.");
  }
  process.exitCode = v.verdict === "not_live" ? 1 : v.verdict === "live_unconfirmed" && !acceptTeaser ? 3 : 0;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`verify-retrospectiva-page: ${(e as Error).message}`);
    process.exit(2);
  });
}
