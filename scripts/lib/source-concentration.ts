/**
 * scripts/lib/source-concentration.ts (#7977, Camada 2 shadow-mode da #7972)
 *
 * Índice Herfindahl-Hirschman (HHI) de concentração de domínio — mitigação
 * S-6 do design da #7972 ("gate de concentração de fonte... rejeita
 * coeficiente cujo suporte tenha concentração acima de limiar entre
 * domínios"). Puro, sem I/O.
 *
 * HHI = Σ (participação de cada domínio)² × 10000 — escala convencional
 * 0-10000 (0 = perfeitamente distribuído, 10000 = 1 domínio sozinho). Usa
 * a mesma escala que reguladores antitruste usam (ex: FTC/DOJ nos EUA) —
 * >2500 é convencionalmente "altamente concentrado" nesse padrão; usado
 * aqui só como referência de leitura, o limiar de rejeição do design é
 * decidido pelo chamador (`shadow-validation-report.ts`), não hardcoded
 * aqui.
 */

export interface DomainConcentration {
  hhi: number;
  top_domain: string | null;
  top_domain_share: number; // 0..1
  domain_count: number;
}

/** Calcula o HHI sobre uma lista de domínios (1 entrada por evento/linha — domínio repetido conta mais de uma vez, é a definição de "participação"). */
export function computeDomainConcentration(domains: ReadonlyArray<string | null>): DomainConcentration {
  const valid = domains.filter((d): d is string => typeof d === "string" && d !== "");
  if (valid.length === 0) return { hhi: 0, top_domain: null, top_domain_share: 0, domain_count: 0 };

  const counts = new Map<string, number>();
  for (const d of valid) counts.set(d, (counts.get(d) ?? 0) + 1);

  let hhi = 0;
  let topDomain: string | null = null;
  let topShare = 0;
  for (const [domain, count] of counts) {
    const share = count / valid.length;
    hhi += share * share * 10000;
    if (share > topShare) {
      topShare = share;
      topDomain = domain;
    }
  }

  return { hhi, top_domain: topDomain, top_domain_share: topShare, domain_count: counts.size };
}
