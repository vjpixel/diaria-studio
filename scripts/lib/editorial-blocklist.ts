/**
 * editorial-blocklist.ts (#1760)
 *
 * Blacklist EDITORIAL de fontes — domínios que o editor decidiu **não** incluir
 * na newsletter por preferência editorial. Distinta da blocklist de AGREGADORES
 * (`aggregators.ts`), que é sobre roundups / falta de fonte primária. Aqui o
 * domínio pode ter fonte primária perfeitamente válida — o editor só não quer.
 *
 * Aplicada no `dedup.ts` (pass 0), descartando os itens do pool ANTES do
 * scoring/categorização.
 *
 * MANTER CURADA — uma entrada por linha, com motivo + data da decisão.
 *
 * #9787: candidatos vêm do monitor de cortes por domínio no gate 4
 * (`scripts/editorial-domain-cuts.ts` — retirado > mantido, ≥ 10 ocorrências);
 * a decisão é sempre do editor, e `--apply-to-code` insere aqui as registradas.
 */
export const EDITORIAL_BLOCKLIST: ReadonlySet<string> = new Set<string>([
  "simonwillison.net", // editor 260603 (#1760) — não incluir conteúdo do Simon Willison
  "sempreupdate.com.br", // editor 260730 — conteúdo genérico tipo listicle sem profundidade (ex: "Como construir seu fluxo de trabalho automatizado com agentes de IA: guia passo a passo para iniciantes")
  "langchain.com", // editor 260806 — blog corporativo publica case study/anúncio de produto sob a categoria "Tutoriais" do seed/sources.csv; review-use-melhor.ts flagou repetidamente como não-tutorial (ex: edição 260806, "Evaluating code review agents with ReviewBench")
  "tiktok.com", // editor 260821 — vídeo de terceiro sem substância verificável como tutorial (ex: edição 260821, "Como Usar O Chat Gpt Para Estudar Para Concurso" no USE MELHOR)
  "chatprd.ai", // editor 261006 — pedido direto do editor (ex: edição 261007, "How to Build a Real-Time Incident Command Dashboard with ChatGPT Sites" no USE MELHOR)
]);

/**
 * #1760: true se a URL é de uma fonte na blacklist editorial. Match por host
 * exato ou subdomínio (`blog.simonwillison.net` → bloqueado). URL inválida →
 * false (defensivo — caller decide).
 */
export function isEditoriallyBlocked(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }
  return isDomainEditoriallyBlocked(host);
}

/**
 * #9787: mesmo match de `isEditoriallyBlocked`, mas recebendo o DOMÍNIO/host
 * já extraído (ex. `chatprd.ai`, `blog.chatprd.ai`) em vez de uma URL.
 */
export function isDomainEditoriallyBlocked(domain: string): boolean {
  const host = domain.replace(/^www\./, "").toLowerCase();
  for (const blocked of EDITORIAL_BLOCKLIST) {
    if (host === blocked || host.endsWith("." + blocked)) return true;
  }
  return false;
}
