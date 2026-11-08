/**
 * #12188: registro versionado de remetentes de newsletter
 * (`seed/newsletter-senders.json`) e detecção de serviço de envio em massa.
 *
 * A classificação IA/não-IA de uma newsletter é SEMPRE a decisão durável do
 * editor sobre o remetente — nunca inferida pelo conteúdo.
 */
import { readFileSync } from "node:fs";

export interface SenderDecision {
  status: "aprovado" | "rejeitado";
  reason: string;
  decided_at: string;
}
export interface SenderRegistry { version: 1; senders: Record<string, SenderDecision> }

export function senderKey(sender: string): string {
  return (sender.match(/<([^>]+)>/)?.[1] ?? sender).trim().toLowerCase();
}

/** Valida uma decisão isolada; lança com o remetente e o campo inválido. */
export function validateSenderDecision(sender: string, decision: unknown): asserts decision is SenderDecision {
  if (senderKey(sender) !== sender || !sender.includes("@")) throw new Error(`Decisão inválida: remetente "${sender}" não é um e-mail normalizado`);
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) throw new Error(`Decisão inválida: ${sender} sem objeto de decisão (recebido ${JSON.stringify(decision)})`);
  const d = decision as Partial<SenderDecision>;
  if (d.status !== "aprovado" && d.status !== "rejeitado") throw new Error(`Decisão inválida: ${sender} com status "${String(d.status)}"`);
  if (typeof d.reason !== "string" || !d.reason.trim()) throw new Error(`Decisão inválida: ${sender} sem reason`);
  if (typeof d.decided_at !== "string" || !Number.isFinite(Date.parse(d.decided_at))) throw new Error(`Decisão inválida: ${sender} com decided_at inválido`);
}

/** Valida o objeto já parseado do registro. Pura. */
export function validateSenderRegistry(value: unknown): SenderRegistry {
  const registry = value as Partial<SenderRegistry> | null;
  if (!registry || typeof registry !== "object" || Array.isArray(registry) || registry.version !== 1 ||
      !registry.senders || typeof registry.senders !== "object" || Array.isArray(registry.senders)) {
    throw new Error("Registro de remetentes inválido: esperado {version: 1, senders: {...}}");
  }
  for (const [sender, decision] of Object.entries(registry.senders)) validateSenderDecision(sender, decision);
  return registry as SenderRegistry;
}

/** Parse + validação do texto do registro (para quem lê o arquivo por DI). */
export function parseSenderRegistry(text: string): SenderRegistry {
  return validateSenderRegistry(JSON.parse(text));
}

export function loadSenderRegistry(path: string): SenderRegistry {
  return parseSenderRegistry(readFileSync(path, "utf8"));
}

/**
 * #12188: registro de fallback quando `seed/newsletter-senders.json` está
 * ausente ou inválido — os senders do `platform.config.json` contam como
 * aprovados (a captura segue como antes do registro, nunca cai a zero).
 */
export function fallbackSenderRegistry(configSenders: string[]): SenderRegistry {
  const senders: Record<string, SenderDecision> = {};
  for (const s of configSenders) {
    const key = senderKey(s);
    if (key.includes("@")) senders[key] = { status: "aprovado", reason: "fallback: senders do platform.config.json (registro ausente/inválido)", decided_at: "1970-01-01T00:00:00Z" };
  }
  return { version: 1, senders };
}

/**
 * Mesma política em Stage 0 e na captura (#12188): registro ausente ou
 * inválido → fallback para os senders do config + `error` com o motivo.
 * `readFile` lança se o arquivo não existe (ENOENT vira `missing: true`).
 */
export function resolveSenderRegistry(
  readFile: () => string,
  configSenders: string[],
): { registry: SenderRegistry; error?: string; missing?: boolean } {
  let text: string;
  try {
    text = readFile();
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return { registry: fallbackSenderRegistry(configSenders), missing, error: missing ? "arquivo ausente" : `ilegível (${err instanceof Error ? err.message : String(err)})` };
  }
  try {
    return { registry: parseSenderRegistry(text) };
  } catch (err) {
    return { registry: fallbackSenderRegistry(configSenders), error: `inválido (${err instanceof Error ? err.message : String(err)})` };
  }
}

export function approvedSenders(registry: SenderRegistry): string[] {
  return Object.keys(registry.senders).filter((s) => registry.senders[s].status === "aprovado");
}

/** `newsletter_auto_capture.senders` normalizados de um config já parseado. */
export function configSendersOf(config: unknown): string[] {
  const senders = (config as { newsletter_auto_capture?: { senders?: unknown } } | null)?.newsletter_auto_capture?.senders;
  return Array.isArray(senders) ? senders.filter((s): s is string => typeof s === "string").map(senderKey) : [];
}

export function classifySender(sender: string, registry: SenderRegistry) {
  const decision: SenderDecision | undefined = Object.hasOwn(registry.senders, senderKey(sender)) ? registry.senders[senderKey(sender)] : undefined;
  return {
    classificacao: decision?.status === "aprovado" ? "IA" : decision ? "não-IA" : "incerta",
    remetente_status: decision?.status ?? "novo-pendente",
    classificacao_motivo: decision?.reason ?? "Remetente sem decisão durável; decidir em lote no gate 4",
  } as const;
}

/**
 * Serviços de envio em massa conhecidos (#12188 item 6). Só remetente cujos
 * cabeçalhos apontam para um destes é oferecido para decisão no gate 4 — o
 * resto (lista de discussão, e-mail pessoal com List-Unsubscribe) aparece só
 * como contagem, sem endereço, e uma rejeição dele nunca vai para o seed.
 * Override em `platform.config.json` → `newsletter_auto_capture.bulk_service_domains`.
 */
export const DEFAULT_BULK_SERVICE_DOMAINS = [
  "beehiiv.com", "substack.com", "substackcdn.com", "convertkit.com", "convertkit-mail.com", "convertkit-mail2.com", "ck.page", "kit.com", "kit-mail3.com",
  "mailchimp.com", "mcsv.net", "mcdlv.net", "list-manage.com", "rsgsv.net", "mailchimpapp.net", "buttondown.email", "buttondown.com",
  "ghost.io", "mailerlite.com", "mlsend.com", "createsend.com", "cmail19.com", "cmail20.com", "klaviyomail.com",
  "constantcontact.com", "hubspotemail.net", "sendibt3.com", "sendibm1.com", "brevo.com", "mailjet.com", "aweber.com",
  "getresponse.com", "medium.com", "sendgrid.net", "mailgun.org",
];

/** Hosts mencionados num texto de cabeçalho (e-mails, URLs, List-ID). */
function hostsIn(text: string): string[] {
  return [...text.toLowerCase().matchAll(/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}/g)].map((m) => m[0]);
}

/** Domínio do serviço de envio em massa nos cabeçalhos, ou null. Pura. */
export function detectBulkService(headers: Array<string | undefined>, domains: string[] = DEFAULT_BULK_SERVICE_DOMAINS): string | null {
  const known = domains.map((d) => d.toLowerCase());
  for (const host of headers.filter((h): h is string => typeof h === "string").flatMap(hostsIn)) {
    const hit = known.find((d) => host === d || host.endsWith(`.${d}`));
    if (hit) return hit;
  }
  return null;
}
