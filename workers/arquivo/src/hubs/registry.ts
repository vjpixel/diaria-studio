/**
 * workers/arquivo/src/hubs/registry.ts (#4558 Parte A)
 *
 * Mapa slug → HTML dos hubs temáticos publicados, servido pelo Worker
 * `arquivo` em `GET /temas/{slug}`. Escrito à mão, atualizado 1x por hub
 * novo — cada valor vem de um `*.generated.ts` (GERADO, não editar à mão;
 * ver `scripts/build-hub-page.ts`). Registry SEPARADO do registry de
 * builders em `scripts/build-hub-page.ts` (`HUB_LOADERS`) de propósito: o
 * Worker só precisa do HTML final, nunca do módulo de conteúdo nem de
 * `scripts/lib/hubs/` — mesma fronteira já usada por `titles-cache.json`
 * (dado gerado, importado estático, zero dependência do gerador Node em
 * runtime).
 */
import { HUB_HTML_ANTHROPIC_CLAUDE, HUB_LASTMOD_ANTHROPIC_CLAUDE } from "./anthropic-claude.generated.ts";
import { HUB_HTML_OPENAI_CHATGPT, HUB_LASTMOD_OPENAI_CHATGPT } from "./openai-chatgpt.generated.ts";
import { HUB_HTML_GOOGLE_GEMINI, HUB_LASTMOD_GOOGLE_GEMINI } from "./google-gemini.generated.ts";
import { HUB_HTML_META_AI, HUB_LASTMOD_META_AI } from "./meta-ai.generated.ts";
import { HUB_HTML_BRASIL_REGULACAO, HUB_LASTMOD_BRASIL_REGULACAO } from "./brasil-regulacao.generated.ts";
import { HUB_HTML_MERCADO_TRABALHO, HUB_LASTMOD_MERCADO_TRABALHO } from "./mercado-trabalho.generated.ts";

export const HUB_REGISTRY: Record<string, string> = {
  "anthropic-claude": HUB_HTML_ANTHROPIC_CLAUDE,
  "openai-chatgpt": HUB_HTML_OPENAI_CHATGPT,
  "google-gemini": HUB_HTML_GOOGLE_GEMINI,
  "meta-ai": HUB_HTML_META_AI,
  "brasil-regulacao": HUB_HTML_BRASIL_REGULACAO,
  "mercado-trabalho": HUB_HTML_MERCADO_TRABALHO,
};

/**
 * slug → `updatedDate` (`YYYY-MM-DD`) do hub (#4911) — mesmo valor que já
 * alimenta o JSON-LD `dateModified` de cada hub (`hub-page.ts`; NÃO
 * `publishedDate`, que alimenta `datePublished` — `<lastmod>`/`Last-Modified`
 * descrevem quando o conteúdo mudou), agora também consumido pelo Worker pra
 * `<lastmod>` do sitemap e pelo header `Last-Modified` de `GET /temas/{slug}`
 * (#4909). Vem de graça de cada `*.generated.ts` — nenhum registro manual
 * novo além da linha de import acima (mesma fronteira de `HUB_REGISTRY`).
 */
export const HUB_LASTMOD: Record<string, string> = {
  "anthropic-claude": HUB_LASTMOD_ANTHROPIC_CLAUDE,
  "openai-chatgpt": HUB_LASTMOD_OPENAI_CHATGPT,
  "google-gemini": HUB_LASTMOD_GOOGLE_GEMINI,
  "meta-ai": HUB_LASTMOD_META_AI,
  "brasil-regulacao": HUB_LASTMOD_BRASIL_REGULACAO,
  "mercado-trabalho": HUB_LASTMOD_MERCADO_TRABALHO,
};
