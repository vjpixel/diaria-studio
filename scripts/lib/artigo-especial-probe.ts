/**
 * artigo-especial-probe.ts (#9099)
 *
 * Confere, depois do merge do PR do artigo e do `deploy-artigos.yml`, que a
 * URL pública do Artigo Especial responde COM O ARTIGO — o gate entre a
 * produção e as 4 ações de divulgação de `/diaria-artigo-especial`.
 *
 * "Responde 200" sozinho não basta: o roteador de assets do Worker pode
 * servir outra coisa no path (página de erro, cache velho), e o deploy pode
 * ter sido PULADO em silêncio (o guard de KV do `deploy-artigos.yml` pula
 * sem falhar o job). Por isso o probe exige, além do 200, que o HTML traga
 * o `og:url` esperado e o bloco de convite do gate (`GATE_CTA_ID`) — prova
 * de que é o TEASER deste artigo, gerado pelo build, que está no ar.
 *
 * `fetch` e `sleep` são injetados — a função é testável sem rede.
 */

import { GATE_CTA_ID } from "./shared/artigo-especial-gate-cta.ts";

export type ProbeFetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface ProbeOptions {
  url: string;
  fetchImpl: ProbeFetch;
  /** Tentativas totais (deploy leva alguns minutos depois do merge). Default 1. */
  attempts?: number;
  /** Espera entre tentativas, ms. Default 30s. */
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type ProbeVerdict =
  | { ok: true; status: number; attempts: number }
  | { ok: false; status: number | null; attempts: number; reason: string };

/** Pura: avalia UMA resposta. `null` = está no ar e é o artigo certo; string = motivo. */
export function assessProbeResponse(url: string, status: number, html: string): string | null {
  if (status !== 200) return `HTTP ${status}`;
  const ogUrl = html.match(/<meta property="og:url" content="([^"]*)"/i)?.[1] ?? null;
  if (ogUrl !== url) return `og:url ${ogUrl === null ? "ausente" : `"${ogUrl}"`} — esperado "${url}" (o path serve outro documento)`;
  if (!html.includes(`id="${GATE_CTA_ID}"`)) {
    return `bloco do gate (id="${GATE_CTA_ID}") ausente — não é o teaser gerado pelo build (artigo completo vazando, ou build não rodou)`;
  }
  return null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Tenta até `attempts` vezes; devolve o 1º sucesso ou o motivo da última falha. Nunca lança. */
export async function probeArtigoEspecial(opts: ProbeOptions): Promise<ProbeVerdict> {
  const attempts = Math.max(1, opts.attempts ?? 1);
  const intervalMs = opts.intervalMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastStatus: number | null = null;
  let lastReason = "nenhuma tentativa";
  for (let i = 1; i <= attempts; i++) {
    try {
      // Cache-buster: o edge da Cloudflare pode servir o 404 de antes do deploy.
      const sep = opts.url.includes("?") ? "&" : "?";
      const res = await opts.fetchImpl(`${opts.url}${sep}probe=${Date.now()}`, {
        method: "GET",
        headers: { "user-agent": "diaria-artigo-especial-probe/1.0", "cache-control": "no-cache" },
      });
      lastStatus = res.status;
      const reason = assessProbeResponse(opts.url, res.status, res.status === 200 ? await res.text() : "");
      if (reason === null) return { ok: true, status: res.status, attempts: i };
      lastReason = reason;
    } catch (e) {
      lastStatus = null;
      lastReason = `erro de rede: ${(e as Error).message}`;
    }
    if (i < attempts) await sleep(intervalMs);
  }
  return { ok: false, status: lastStatus, attempts, reason: lastReason };
}
