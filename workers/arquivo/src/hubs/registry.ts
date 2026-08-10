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
import { HUB_HTML_ANTHROPIC_CLAUDE } from "./anthropic-claude.generated.ts";
import { HUB_HTML_OPENAI_CHATGPT } from "./openai-chatgpt.generated.ts";
import { HUB_HTML_GOOGLE_GEMINI } from "./google-gemini.generated.ts";
import { HUB_HTML_META_AI } from "./meta-ai.generated.ts";

export const HUB_REGISTRY: Record<string, string> = {
  "anthropic-claude": HUB_HTML_ANTHROPIC_CLAUDE,
  "openai-chatgpt": HUB_HTML_OPENAI_CHATGPT,
  "google-gemini": HUB_HTML_GOOGLE_GEMINI,
  "meta-ai": HUB_HTML_META_AI,
};
