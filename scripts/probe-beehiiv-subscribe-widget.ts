#!/usr/bin/env node
/**
 * probe-beehiiv-subscribe-widget.ts (#5545 item 3)
 *
 * Sondagem ESTÁTICA (sem navegador) do widget "Assinar grátis" da home. A
 * #5522 já registrou o limite real desta abordagem: o botão é widget JS do
 * Beehiiv, sem `href` no HTML — "não dá pra provar por inspeção estática se
 * ele carrega a query string adiante". Este script não tenta provar isso.
 * Reduz a superfície: baixa a home (com a query string do braço, se
 * passada) e reporta o que o HTML servido de fato contém sobre o widget
 * (scripts carregados, atributos de config, quantos elementos mencionam
 * subscribe/assinar, se há `<form>` nativo além do widget). Serve pra
 * prever o resultado e diagnosticar rápido uma falha.
 *
 * NÃO serve como aprovação — o gate continua sendo a passada real no
 * navegador (`docs/preflight-utm-cookie-roteiro.md`).
 *
 * Uso:
 *   npx tsx scripts/probe-beehiiv-subscribe-widget.ts
 *   npx tsx scripts/probe-beehiiv-subscribe-widget.ts --url "https://diar.ia.br/?utm_source=google-ads&utm_medium=cpc&utm_campaign=preflight-2608"
 *   npx tsx scripts/probe-beehiiv-subscribe-widget.ts --json
 *
 * GET público simples, sem autenticação, sem API/MCP Beehiiv — mesmo padrão
 * de `scripts/beehiiv-home-meta-check.ts`.
 */
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { DEFAULT_HOME_URL } from "./lib/preflight-utm-arms.ts";

export interface SubscribeWidgetProbe {
  fetched_url: string;
  html_length: number;
  beehiiv_scripts: string[];
  native_forms: number;
  subscribe_related_elements: number;
  config_attributes_found: string[];
}

/**
 * Pura — analisa o HTML já baixado (nunca faz a chamada de rede). Regex
 * simples de propósito: isto é diagnóstico auxiliar, não um parser de DOM —
 * um falso-negativo aqui só significa "rode o passo real no navegador",
 * nunca bloqueia nada.
 */
export function probeHtml(html: string, fetchedUrl: string): SubscribeWidgetProbe {
  const scriptSrcRe = /<script[^>]+src=["']([^"']*beehiiv[^"']*)["']/gi;
  const beehiiv_scripts: string[] = [];
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptSrcRe.exec(html))) {
    beehiiv_scripts.push(scriptMatch[1]);
  }

  const native_forms = (html.match(/<form\b/gi) ?? []).length;

  const subscribeElRe = /(?:id|class|data-[\w-]+)=["'][^"']*(?:subscribe|assinar)[^"']*["']/gi;
  const subscribe_related_elements = (html.match(subscribeElRe) ?? []).length;

  const configAttrRe = /data-(publication-id|utm-source|utm-medium|utm-campaign|embed[-\w]*)=["']([^"']*)["']/gi;
  const config_attributes_found: string[] = [];
  let configMatch: RegExpExecArray | null;
  while ((configMatch = configAttrRe.exec(html))) {
    config_attributes_found.push(`${configMatch[1]}="${configMatch[2]}"`);
  }

  return {
    fetched_url: fetchedUrl,
    html_length: html.length,
    beehiiv_scripts,
    native_forms,
    subscribe_related_elements,
    config_attributes_found,
  };
}

/** Pura — relatório texto do que foi encontrado, com o aviso de escopo. */
export function formatProbeReport(probe: SubscribeWidgetProbe): string {
  return [
    `URL: ${probe.fetched_url}`,
    `HTML: ${probe.html_length} bytes`,
    `Scripts beehiiv encontrados: ${probe.beehiiv_scripts.length ? probe.beehiiv_scripts.join(", ") : "(nenhum)"}`,
    `<form> nativos na página: ${probe.native_forms}`,
    `Elementos com id/class/data-* mencionando subscribe/assinar: ${probe.subscribe_related_elements}`,
    `Atributos de config encontrados: ${probe.config_attributes_found.length ? probe.config_attributes_found.join(", ") : "(nenhum)"}`,
    ``,
    `NOTA: isto é diagnóstico, não aprovação. O widget carrega via JS — só a`,
    `passada real no navegador (docs/preflight-utm-cookie-roteiro.md) confirma`,
    `se a query string chega ao cadastro.`,
  ].join("\n");
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const url = getStringArg(argv, "url") ?? DEFAULT_HOME_URL;
  const jsonMode = argv.includes("--json");

  fetch(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
      const html = await res.text();
      const probe = probeHtml(html, url);
      if (jsonMode) {
        process.stdout.write(JSON.stringify(probe, null, 2) + "\n");
      } else {
        process.stdout.write(formatProbeReport(probe) + "\n");
      }
    })
    .catch((err) => {
      process.stderr.write(`[probe-beehiiv-subscribe-widget] ERRO: ${String(err)}\n`);
      process.exit(1);
    });
}
