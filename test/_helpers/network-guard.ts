/**
 * network-guard.ts (#6222)
 *
 * Um teste que mocka `globalThis.fetch` NÃO cobre `node:https`/`node:http`
 * — são APIs de transporte independentes, e vários módulos deste repo
 * usam `https.request` direto (ex: `uploadTextToWorkerKV` em
 * `scripts/lib/cloudflare-kv-upload.ts`, deliberado — ver docstring lá,
 * "evita chunked-encoding quirk do fetch global em alguns Node builds").
 * `clarice-engagement-cohorts-v2.test.ts` mockava só `fetch` e ainda assim
 * vazava pra rede real da Cloudflare quando `data/` continha opt-outs
 * administrativos reais (universe != 0 despite campanhas=[] mockado —
 * ver `#6222` no PR).
 *
 * `installNetworkRequestGuard()` substitui `https.request`/`http.request`
 * por uma função que LANÇA imediatamente, ANTES de qualquer socket abrir —
 * failo alto, síncrono, sem tentar conectar. Chamar no `test.before()` de um
 * arquivo de teste que não deveria, sob NENHUMA circunstância, tocar rede
 * real; restaurar no `test.after()`. Não cobre `net.connect` bruto (nenhum
 * script de produção deste repo usa isso hoje) nem `fetch` (mocke `fetch`
 * separadamente, como os testes já fazem — este guard é o complemento pro
 * caminho que o mock de `fetch` NÃO alcança).
 */

import https from "node:https";
import http from "node:http";

type RequestFn = typeof https.request;

function describeArg(arg: unknown): string {
  try {
    if (typeof arg === "string") return arg;
    return JSON.stringify(arg).slice(0, 300);
  } catch {
    return String(arg);
  }
}

function makeThrowingRequest(moduleName: "https" | "http"): RequestFn {
  const throwing = ((...args: unknown[]) => {
    throw new Error(
      `[network-guard #6222] ${moduleName}.request bloqueado durante o teste — ` +
        `chamada de rede real não mockada. Alvo: ${describeArg(args[0])}`,
    );
  }) as RequestFn;
  return throwing;
}

/**
 * Instala o guard. Retorna a função de restore — SEMPRE chamar em
 * `test.after()` (ou `finally`), mesmo se o teste falhar, senão o override
 * vaza pra outros arquivos de teste que rodem no MESMO processo.
 */
export function installNetworkRequestGuard(): () => void {
  const originalHttpsRequest = https.request;
  const originalHttpRequest = http.request;

  https.request = makeThrowingRequest("https");
  http.request = makeThrowingRequest("http");

  return () => {
    https.request = originalHttpsRequest;
    http.request = originalHttpRequest;
  };
}
