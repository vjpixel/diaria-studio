/**
 * scripts/lib/shared/utm-link-check.ts (#5514)
 *
 * Prevenção leve pro achado da #5514: 45% da coorte de lançamento entrou
 * sem NENHUMA atribuição porque a divulgação da campanha saiu com links
 * `diar.ia.br` sem UTM em superfícies que apagam referrer (navegador in-app,
 * WhatsApp, e-mail). Nada hoje obriga um link de campanha novo a usar
 * `utm-registry.ts` (que já tem perfis por canal) — este módulo é o
 * mecanismo de VERIFICAÇÃO, não de enforcement: um lint puro que, dado um
 * texto de post/copy, aponta quais URLs de marca não têm `utm_source`/
 * `utm_campaign`, para ser rodado ANTES de publicar (não depois, quando o
 * dado já é irrecuperável — ver `scripts/infer-cohort-attribution.ts` e o
 * comentário da #5514 sobre o que a API Beehiiv não guarda).
 *
 * **Decisão de escopo (registrada aqui e no PR body):** um checker
 * automático PURO — texto in, findings out — é mais barato e menos frágil
 * que um regex hardcoded no meio de cada playbook de publicação, e generaliza
 * pra qualquer superfície nova (LinkedIn, X/Buffer, Instagram, apoia.se,
 * README de terceiro) sem precisar tocar N arquivos. Fica em `lib/shared/`
 * (não `lib/diaria/`) porque nada aqui é específico da diária — é aplicável
 * a qualquer copy que mencione um link `diar.ia.br` em qualquer canal
 * (inclusive o mensal). Não é enforcement pesado: `checkUtmCoverage` só
 * REPORTA — quem decide travar publicação nisso (ou só logar aviso) é o
 * chamador. Ver `scripts/check-utm-coverage.ts` para o wrapper de CLI usado
 * antes de publicar copy ad-hoc de campanha (ex: divulgação em grupo de
 * WhatsApp, post manual fora do pipeline automatizado).
 */

/** Hosts de marca cobertos pela checagem — `diar.ia.br` raiz e qualquer
 *  subdomínio (`arquivo.`, `livros.`, `cursos.`, `eia.`, `especial.`,
 *  `artigo.`, `studio.`, futuros). @pure */
export function isBrandHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "diar.ia.br" || h.endsWith(".diar.ia.br");
}

/** Extrai todas as URLs `http(s)://` de um texto livre. URLs malformadas
 *  (capturadas pelo regex mas rejeitadas por `new URL`) são descartadas
 *  silenciosamente — não é objetivo deste lint validar sintaxe de URL, só
 *  cobertura de UTM nas que são válidas. @pure */
function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? [];
  return matches;
}

export interface UtmLinkIssue {
  url: string;
  /** Subconjunto de `["utm_source", "utm_campaign"]` — os parâmetros
   *  ausentes ou vazios nesta URL. */
  missing: string[];
}

/**
 * Varre `text` por URLs de hosts de marca (`isBrandHost`) e reporta as que
 * não têm `utm_source` e/ou `utm_campaign` preenchidos. `utm_medium` fica de
 * fora do critério de propósito — é o par `source`+`campaign` que faltou nos
 * 52 casos da #5514 (o `utm_channel: website` presente neles não é algo que
 * o autor do link controla, é inferido pela Beehiiv). Ordem de saída segue a
 * ordem de aparição no texto; URLs de host não-marca (artigo original
 * linkado, etc.) nunca entram no resultado. @pure
 */
export function checkUtmCoverage(text: string): UtmLinkIssue[] {
  const issues: UtmLinkIssue[] = [];
  for (const raw of extractUrls(text)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue; // não é uma URL válida — fora de escopo deste lint
    }
    if (!isBrandHost(url.hostname)) continue;

    const missing: string[] = [];
    if (!url.searchParams.get("utm_source")?.trim()) missing.push("utm_source");
    if (!url.searchParams.get("utm_campaign")?.trim()) missing.push("utm_campaign");
    if (missing.length > 0) issues.push({ url: raw, missing });
  }
  return issues;
}

/** `true` se todo link de marca em `text` tem `utm_source`+`utm_campaign`
 *  (ou não há nenhum link de marca). Atalho para o caller que só quer um
 *  booleano de gate. @pure */
export function hasFullUtmCoverage(text: string): boolean {
  return checkUtmCoverage(text).length === 0;
}
