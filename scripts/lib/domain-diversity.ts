/**
 * domain-diversity.ts (#5735, #8593)
 *
 * Contagem de domínio EDITORIAL compartilhada entre o validador do Stage 4
 * (`validate-domain-diversity.ts`, gate-blocking) e a aplicação do limite já
 * na montagem do Stage 2 (`apply-stage2-caps.ts`, #8593). Uma só definição de
 * "domínio que conta" garante que o Stage 2 nunca monte uma edição que o gate
 * do Stage 4 reprovaria.
 */
import { extractHostname, registrableDomain } from "./registrable-domain.ts";
import { isNonEditorialHost } from "./ctr-utils.ts";

export const DEFAULT_MAX_PER_DOMAIN = 2;

/**
 * Domínio registrável que CONTA pro limite, ou null quando a URL não parseia
 * ou o host é não-editorial (#5813: rodapé/link de casa/crédito de imagem).
 * @pure
 */
export function editorialDomain(url: string): string | null {
  const hostname = extractHostname(url);
  if (hostname && isNonEditorialHost(hostname)) return null;
  return registrableDomain(url) ?? null;
}

export interface DomainLimitCandidate {
  url: string | undefined;
  score: number | undefined;
  /** Protegido: nunca removido (destaques), mas conta pro limite. */
  protected: boolean;
  /** Menor = mais prioritário (buckets). Só depois vem o score. Destaques: -1. */
  priority: number;
  /** Ordem original (desempate estável e identificador do candidato). */
  order: number;
}

/**
 * Dado o conjunto de candidatos, devolve os `order` a REMOVER por domínio que
 * excede `max`. Protegidos ocupam vaga primeiro; os demais competem por
 * prioridade de bucket, depois score desc (sem score = 0), depois ordem original.
 *
 * Diferença deliberada vs `validateDomainDiversity`: aqui hosts de rótulo único
 * (`localhost`, fixtures) são ignorados — o Stage 2 é mais permissivo; o gate do
 * Stage 4 continua sendo a palavra final.
 * @pure
 */
export function selectDomainExcess(
  candidates: DomainLimitCandidate[],
  max: number = DEFAULT_MAX_PER_DOMAIN,
): Array<{ order: number; domain: string; reason: string }> {
  const byDomain = new Map<string, DomainLimitCandidate[]>();
  for (const c of candidates) {
    if (!c.url) continue;
    const d = editorialDomain(c.url);
    if (d && !d.includes(".")) continue; // host de rótulo único (fixture/intranet) não é domínio registrável real
    if (!d) continue;
    const list = byDomain.get(d) ?? [];
    list.push(c);
    byDomain.set(d, list);
  }
  const removals: Array<{ order: number; domain: string; reason: string }> = [];
  for (const [domain, list] of byDomain) {
    if (list.length <= max) continue;
    const prot = list.filter((c) => c.protected).length;
    const slots = Math.max(0, max - prot);
    const movable = list
      .filter((c) => !c.protected)
      .sort(
        (a, b) =>
          a.priority - b.priority || (b.score ?? 0) - (a.score ?? 0) || a.order - b.order,
      );
    for (const c of movable.slice(slots)) {
      removals.push({
        order: c.order,
        domain,
        reason: `${domain} excede ${max} URLs/edição (#8593); ${list.length} candidatas, ${prot} em destaque`,
      });
    }
  }
  return removals;
}
