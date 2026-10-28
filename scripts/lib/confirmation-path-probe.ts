/**
 * scripts/lib/confirmation-path-probe.ts (#8548 item 4)
 *
 * Sonda somente-leitura do caminho DEPOIS do clique de confirmação: o e-mail
 * de double opt-in do Kit (form `9897918`) redireciona para o endereço
 * configurado em "After confirming redirect to", e o botão da Brevo
 * (worker `reativar`, #8539) redireciona com 303 para
 * `https://diar.ia.br/confirmada?via=brevo`. Esta sonda segue cada um desses
 * destinos, salto a salto, e confere que terminam na página `/confirmada`
 * no ar, com status 200, HTML, o título da confirmação, a linha de entrega
 * certa para o `?via=` e o container GTM que dispara a conversão.
 *
 * ## O que ela NÃO cobre (e por quê)
 *
 * - O link do botão do e-mail (`app.kit.com/forms/confirm?key=…`) exige uma
 *   chave real de um assinante pendente: segui-lo CONFIRMARIA alguém. Nunca
 *   é sondado.
 * - A configuração "After confirming redirect to" do form não é exposta pela
 *   API v4 do Kit (`GET /v4/forms` não traz o campo). A sonda cobre os dois
 *   destinos possíveis (o legado `eia.diar.ia.br/confirmado`, que o
 *   `docs/kit-doi-confirmation-copy.md` registra como ainda configurado, e
 *   o novo `diar.ia.br/confirmada`), mas qual deles o form usa só se
 *   confere no painel do Kit.
 * - GET em `/confirmada` não tem efeito colateral no servidor: a página é
 *   estática (`handleConfirmadoPage`) e a conversão sai do GTM, que só roda
 *   em navegador. Um `fetch` sem JavaScript não registra conversão.
 *
 * A parte pura (`evaluateConfirmationProbe`) julga um resultado já buscado;
 * `fetchConfirmationProbe` faz a rede, com `fetch` injetável para teste.
 */

import { PAGE_URL, VIA_BREVO, renderTimingLine } from "./shared/confirmado-page.ts";
import { GTM_CONTAINER_ID } from "./shared/seo-meta.ts";

/** Teto de saltos por sonda — a cadeia mais longa esperada hoje é 2
 *  (`eia.diar.ia.br/confirmado` → `diar.ia.br/confirmada`). */
export const MAX_REDIRECT_HOPS = 5;

/** Texto do `<h1>` da página de confirmação. */
export const CONFIRMADA_HEADING = "Assinatura confirmada";

/** User-Agent da sonda — sem UA o Cloudflare pode responder com challenge. */
export const PROBE_USER_AGENT = "Mozilla/5.0 (compatible; diaria-confirmation-probe/1.0; +https://diar.ia.br)";

export interface ConfirmationProbe {
  id: string;
  url: string;
  /** `?via=` que deve chegar intacto à página final (ausente = padrão Kit). */
  via?: string;
  descricao: string;
}

export const CONFIRMATION_PATH_PROBES: readonly ConfirmationProbe[] = [
  {
    id: "kit-redirect-legado",
    url: "https://eia.diar.ia.br/confirmado",
    descricao: "destino legado do form Kit 9897918 (docs/kit-doi-confirmation-copy.md: ainda configurado no painel)",
  },
  {
    id: "apex-legado",
    url: "https://diar.ia.br/confirmado",
    descricao: "path antigo no apex (301 do #8554), citado por e-mails já entregues",
  },
  {
    id: "kit-destino",
    url: PAGE_URL,
    descricao: "destino canônico do e-mail de confirmação do Kit",
  },
  {
    id: "brevo-destino",
    url: `${PAGE_URL}?via=${VIA_BREVO}`,
    via: VIA_BREVO,
    descricao: "destino do botão da Brevo (worker reativar, 303 do #8539)",
  },
];

export interface ProbeHop {
  url: string;
  status: number;
  /** Header `Location` resolvido contra `url` (só em 3xx). */
  location?: string;
}

export interface ProbeFetchResult {
  hops: ProbeHop[];
  /** Corpo da última resposta (só quando ela não é redirect). */
  finalBody: string | null;
  finalContentType: string | null;
  /** Erro de rede / loop de redirect; presente = sonda não completou. */
  error?: string;
}

export interface ProbeVerdict {
  id: string;
  url: string;
  ok: boolean;
  finalUrl: string | null;
  finalStatus: number | null;
  saltos: number;
  problemas: string[];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Julga o resultado de uma sonda. @pure */
export function evaluateConfirmationProbe(probe: ConfirmationProbe, result: ProbeFetchResult): ProbeVerdict {
  const problemas: string[] = [];
  const last = result.hops[result.hops.length - 1];
  const finalUrl = last?.url ?? null;
  const finalStatus = last?.status ?? null;
  const saltos = Math.max(result.hops.length - 1, 0);

  if (result.error) problemas.push(`sonda não completou: ${result.error}`);
  if (!last) {
    if (!result.error) problemas.push("nenhuma resposta registrada");
    return { id: probe.id, url: probe.url, ok: false, finalUrl, finalStatus, saltos, problemas };
  }

  for (const hop of result.hops.slice(0, -1)) {
    if (!REDIRECT_STATUSES.has(hop.status)) problemas.push(`salto intermediário com status ${hop.status} em ${hop.url}`);
  }
  if (finalStatus !== 200) problemas.push(`status final ${finalStatus} (esperado 200) em ${finalUrl}`);

  let final: URL | null = null;
  try {
    final = new URL(finalUrl!);
  } catch {
    problemas.push(`URL final inválida: ${finalUrl}`);
  }
  const canonical = new URL(PAGE_URL);
  if (final) {
    if (final.host !== canonical.host || final.pathname !== canonical.pathname) {
      problemas.push(`terminou em ${final.host}${final.pathname}, não em ${canonical.host}${canonical.pathname}`);
    }
    const via = final.searchParams.get("via") ?? undefined;
    if (via !== probe.via) {
      problemas.push(`?via= chegou como ${via === undefined ? "ausente" : `"${via}"`}, esperado ${probe.via === undefined ? "ausente" : `"${probe.via}"`}`);
    }
  }

  if (finalStatus === 200) {
    const ct = (result.finalContentType ?? "").toLowerCase();
    if (!ct.includes("text/html")) problemas.push(`content-type "${result.finalContentType ?? ""}" (esperado text/html)`);
    const body = result.finalBody ?? "";
    if (!body.includes(CONFIRMADA_HEADING)) problemas.push(`página sem o título "${CONFIRMADA_HEADING}"`);
    const timing = renderTimingLine(probe.via);
    if (!body.includes(timing)) {
      problemas.push(
        `página sem a linha de entrega da variante ${probe.via ?? "padrão"} (worker publicado defasado em relação ao repo?)`,
      );
    }
    if (!body.includes(GTM_CONTAINER_ID)) {
      problemas.push(`página sem o container ${GTM_CONTAINER_ID}: a conversão de confirmação não dispara`);
    }
  }

  return { id: probe.id, url: probe.url, ok: problemas.length === 0, finalUrl, finalStatus, saltos, problemas };
}

/** Segue uma sonda salto a salto (`redirect: "manual"`), só GET. Nunca lança:
 *  erro de rede vira `error` no resultado. */
export async function fetchConfirmationProbe(
  probe: ConfirmationProbe,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<ProbeFetchResult> {
  const hops: ProbeHop[] = [];
  let url = probe.url;
  try {
    for (let i = 0; i <= MAX_REDIRECT_HOPS; i++) {
      const res = await fetchFn(url, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": PROBE_USER_AGENT, Accept: "text/html" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (REDIRECT_STATUSES.has(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) {
          hops.push({ url, status: res.status });
          return { hops, finalBody: null, finalContentType: null, error: `redirect ${res.status} sem Location em ${url}` };
        }
        const next = new URL(loc, url).toString();
        hops.push({ url, status: res.status, location: next });
        url = next;
        continue;
      }
      hops.push({ url, status: res.status });
      return { hops, finalBody: await res.text(), finalContentType: res.headers.get("content-type") };
    }
    return { hops, finalBody: null, finalContentType: null, error: `mais de ${MAX_REDIRECT_HOPS} redirects` };
  } catch (e) {
    return { hops, finalBody: null, finalContentType: null, error: e instanceof Error ? e.message : String(e) };
  }
}
