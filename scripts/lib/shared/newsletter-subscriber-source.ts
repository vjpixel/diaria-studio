/**
 * newsletter-subscriber-source.ts (#6051 — migração Beehiiv → Kit, fatia
 * "superfícies de leitura de ASSINANTE" do épico #463)
 *
 * ## O problema que este módulo resolve
 *
 * `scripts/count-subscriptions-by-utm.ts` (consumido pelo painel
 * `/utms` do Studio, `scripts/studio-ui/studio-utms.ts`) lê a base de
 * assinantes ao vivo pra agregar por `utm_source`/`utm_campaign` — hoje só
 * contra a Beehiiv. Este módulo dá ao caller um jeito de escolher o backend
 * SEM precisar saber qual API está por trás, mesmo desenho de
 * `newsletter-read-source.ts` (#6184/#6362) — que resolve o mesmo problema
 * pro eixo POST/broadcast, não SUBSCRIBER.
 *
 * ## Terceira chave de flag, dedicada (mesmo racional do `read_backend`)
 *
 * `publishing.newsletter.backend` controla o backend de ENVIO;
 * `publishing.newsletter.read_backend` controla LEITURA DE POSTS (dedup,
 * digest mensal). Nenhuma das duas é a pergunta certa pra "onde estão os
 * assinantes pra fins de leitura/agregação" — a prontidão desse eixo é
 * independente das outras duas (a atribuição UTM nativa do Kit só existe
 * pra quem se cadastrou pelo formulário hospedado no Kit; quem entrou via
 * API/worker não carrega `attribution`, ver `kit-subscribers.ts`). Por
 * isso: chave PRÓPRIA, `publishing.newsletter.subscriber_backend`, default
 * `"beehiiv"` — migrar aqui não depende de, nem afeta, `backend`/
 * `read_backend`.
 *
 * ## Limitação do lado Kit — CORRIGIDA no consumidor (#7359, não muda esta chave)
 *
 * `KitSubscriberSummary.attribution` (bloco nativo, `include[]=attribution`)
 * só vem com UTM preenchido pra assinantes que se cadastraram pelo
 * formulário NATIVO do Kit — confirmado em `kit-subscribers.ts`/#6425 Parte
 * A. Assinante criado via `POST /v4/subscribers` (os workers de assinatura,
 * #6339/#6048 — hoje a maioria real do cadastro, incluindo o form da home
 * que chama `POST /jogar/subscribe`) carrega o bloco mas com UTM nulo
 * (medido ao vivo no #7174). Isso NÃO é subcontagem inevitável: a
 * atribuição real desses cadastros vive nos custom fields
 * `utm_source`/`utm_campaign` (gravados por `subscribeToKit`,
 * `workers/poll/src/subscribe.ts`) — `fetchAndAggregateKit`
 * (`count-subscriptions-by-utm.ts`) lê `fields` primeiro, com `attribution`
 * só como fallback pro caso nativo (#7359). O que este comentário registra
 * é só que a leitura de assinante por este módulo continua defaultando pra
 * `"beehiiv"` (ver nota abaixo) — migrar essa chave é uma decisão separada
 * de já ter corrigido a fonte certa do lado Kit.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBeehiivConfig, type BeehiivConfig } from "../beehiiv-config.ts";
import { resolveKitConfig, type KitConfig } from "../kit-config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_CONFIG_PATH = resolve(ROOT, "platform.config.json");

export type NewsletterSubscriberBackend = "beehiiv" | "kit";

/**
 * Lê `platform.config.json` → `publishing.newsletter.subscriber_backend`.
 * Mesma tolerância de parse (trim + lowercase, default silencioso em
 * ausência, log + default em valor desconhecido, `ok:false` propagado só
 * quando o arquivo EXISTE mas está corrompido) que
 * `resolveReadBackendChecked` em `newsletter-read-source.ts` — não
 * reimplementado ali porque a chave é diferente, mas o contrato é o mesmo
 * de propósito, pra quem já conhece um dos dois módulos reconhecer o outro.
 */
function resolveSubscriberBackendChecked(
  configPath: string,
): { ok: true; backend: NewsletterSubscriberBackend } | { ok: false; reason: string } {
  if (!existsSync(configPath)) return { ok: true, backend: "beehiiv" };
  let cfg: { publishing?: { newsletter?: { subscriber_backend?: string } } };
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    return { ok: false, reason: `platform.config.json inválido: ${(e as Error).message}` };
  }
  const raw = cfg.publishing?.newsletter?.subscriber_backend;
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "kit") return { ok: true, backend: "kit" };
  if (normalized && normalized !== "beehiiv") {
    console.error(
      `[newsletter-subscriber-source] publishing.newsletter.subscriber_backend desconhecido: ${JSON.stringify(raw)} — caindo em beehiiv`,
    );
  }
  return { ok: true, backend: "beehiiv" };
}

/** Convenience pura — sempre devolve um backend usável, nunca lança. Use
 *  quando "beehiiv" no erro é aceitável (só quer saber "qual backend
 *  hoje"). */
export function resolveNewsletterSubscriberBackend(
  configPath: string = DEFAULT_CONFIG_PATH,
): NewsletterSubscriberBackend {
  const result = resolveSubscriberBackendChecked(configPath);
  return result.ok ? result.backend : "beehiiv";
}

export type NewsletterSubscriberConfig =
  | { backend: "beehiiv"; config: BeehiivConfig }
  | { backend: "kit"; config: KitConfig };

export type NewsletterSubscriberConfigResult =
  | { ok: true; config: NewsletterSubscriberConfig }
  | { ok: false; reason: string };

/**
 * Resolve backend + credenciais correspondentes, sem nunca lançar ou chamar
 * `process.exit` (mesmo contrato de `resolveNewsletterReadConfig`).
 *
 * @param opts.backend      Override do backend — útil pra teste ou pra um
 *                           caller que já sabe o backend por outro meio.
 * @param opts.env           Fonte do env — default `process.env`.
 * @param opts.configPath    Path de `platform.config.json` — default o real.
 */
export function resolveNewsletterSubscriberConfig(opts: {
  backend?: NewsletterSubscriberBackend;
  env?: Record<string, string | undefined>;
  configPath?: string;
} = {}): NewsletterSubscriberConfigResult {
  let backend: NewsletterSubscriberBackend;
  if (opts.backend) {
    backend = opts.backend;
  } else {
    const resolved = resolveSubscriberBackendChecked(opts.configPath ?? DEFAULT_CONFIG_PATH);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    backend = resolved.backend;
  }
  if (backend === "kit") {
    const result = resolveKitConfig(opts.env);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, config: { backend: "kit", config: result.config } };
  }
  const result = resolveBeehiivConfig(opts.env, opts.configPath ?? DEFAULT_CONFIG_PATH);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, config: { backend: "beehiiv", config: result.config } };
}
