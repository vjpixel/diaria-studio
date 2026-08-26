/**
 * scripts/lib/brevo-error-classify.ts (#6035, #5942, #5653)
 *
 * Classificador PURO de erro HTTP da Brevo — dado status + corpo da
 * resposta, decide em qual das 5 classes acionáveis o erro cai, extraindo
 * o IP citado quando aplicável. Nasceu do achado ao vivo (24-25/08/2026,
 * #6124/#6132/#6137) de que um 401 "unrecognised IP" (bloqueio de allowlist
 * por CONTA) e um 401 de credencial inválida/revogada são hoje
 * INDISTINGUÍVEIS na mensagem final que os 3 scripts systemd falhados
 * (`clarice-sync-brevo.ts`, `clarice-envio-guard.ts`,
 * `clarice-import-waves.ts`) despejam no log — o operador precisa abrir o
 * log, ler o JSON cru e decidir manualmente qual das duas causas é.
 *
 * Diferença de escopo pra `brevo-unrecognised-ip-alarm.ts` (#6137, já em
 * produção): aquele módulo é STATEFUL — reconcilia contra `gh` e um
 * arquivo de estado local pra abrir/fechar UMA issue por fingerprint
 * conta+IP. Este módulo é só a CLASSIFICAÇÃO pura (sem I/O), pensado pra
 * ser chamado em qualquer ponto que precise decorar uma mensagem de erro
 * com a ação certa — reusa `parseUnrecognisedIpBody`/`AUTHORISED_IPS_URL`
 * de lá (mesma regex, sem duplicar) em vez de reimplementar a extração.
 */
import { parseUnrecognisedIpBody, AUTHORISED_IPS_URL } from "./brevo-unrecognised-ip-alarm.ts";

export { AUTHORISED_IPS_URL };

export type BrevoErrorClass =
  | "ip-nao-autorizado"
  | "rate-limit"
  | "auth-invalida"
  | "transitorio"
  | "desconhecido";

export interface BrevoErrorClassification {
  errorClass: BrevoErrorClass;
  /** IP citado pela própria resposta da Brevo — só presente quando
   * `errorClass === "ip-nao-autorizado"`. */
  ip: string | null;
}

/**
 * Classifica um erro HTTP da Brevo a partir do status + corpo bruto da
 * resposta. Pura — nunca lança, nunca faz I/O.
 *
 *  - 401 com corpo "unrecognised IP address X" → `ip-nao-autorizado` (bloqueio
 *    de allowlist por CONTA, não credencial — ação: autorizar o IP).
 *  - 401 com qualquer outro corpo → `auth-invalida` (key errada/revogada —
 *    ação: conferir a env var).
 *  - 429 → `rate-limit` (100 req/hora por CONTA na família
 *    `/v3/emailCampaigns*`, ver docs/brevo-rate-limits.md — ação: esperar a
 *    janela ou desistir se o Retry-After não couber no orçamento).
 *  - >=500 → `transitorio` (erro do servidor Brevo — retry pode ajudar).
 *  - qualquer outro status → `desconhecido` (sem ação específica conhecida).
 */
export function classifyBrevoError(
  status: number,
  bodyText: string | null | undefined,
): BrevoErrorClassification {
  if (status === 401) {
    const ip = parseUnrecognisedIpBody(bodyText);
    if (ip) return { errorClass: "ip-nao-autorizado", ip };
    return { errorClass: "auth-invalida", ip: null };
  }
  if (status === 429) return { errorClass: "rate-limit", ip: null };
  if (status >= 500) return { errorClass: "transitorio", ip: null };
  return { errorClass: "desconhecido", ip: null };
}

/** Texto de ação por classe — usado por `formatBrevoApiError` abaixo, e
 * reusável por qualquer chamador que já tenha a classificação em mãos. */
export function describeBrevoErrorAction(c: BrevoErrorClassification): string | null {
  switch (c.errorClass) {
    case "ip-nao-autorizado":
      return `AÇÃO: adicione o IP ${c.ip} em ${AUTHORISED_IPS_URL} — é um bloqueio de allowlist ` +
        `por CONTA, não uma credencial errada.`;
    case "auth-invalida":
      return "possível credencial inválida/revogada (não é bloqueio de IP) — confira a API key usada.";
    case "rate-limit":
      return "rate limit da Brevo (100 req/hora por CONTA, família /v3/emailCampaigns* — " +
        "ver docs/brevo-rate-limits.md).";
    case "transitorio":
      return "erro transitório do servidor Brevo (5xx) — retry pode ajudar.";
    case "desconhecido":
      return null;
  }
}

/**
 * Monta a mensagem final de erro pra um call site `Brevo API {METHOD} {path}
 * falhou ({status}): {bodyText}` — preserva o corpo cru (nunca some, fica
 * disponível pra debug) e ANEXA a ação exata quando a classe permitir uma,
 * em vez de deixar o operador decifrar o JSON cru sozinho.
 */
export function formatBrevoApiError(
  method: string,
  path: string,
  status: number,
  bodyText: string,
): string {
  const raw = `Brevo API ${method} ${path} falhou (${status}): ${bodyText}`;
  const classification = classifyBrevoError(status, bodyText);
  const action = describeBrevoErrorAction(classification);
  return action ? `${raw} — ${action}` : raw;
}
