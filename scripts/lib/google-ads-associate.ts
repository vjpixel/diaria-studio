/**
 * scripts/lib/google-ads-associate.ts (#5262)
 *
 * Lógica pura do passo "associar o developer token ao projeto Google Cloud",
 * pré-requisito da verificação de marca do Basic Access da Google Ads API.
 *
 * O ponto não-óbvio, e o motivo deste módulo existir separado do CLI: a
 * associação acontece pelo simples FATO de uma chamada à API ter sido feita
 * com o developer token + uma credencial OAuth do projeto. A doc oficial é
 * explícita nos três eixos que normalmente bloqueariam isso:
 *
 *   "It doesn't matter whether your API call succeeds or fails.
 *    It doesn't matter what access level your developer token has."
 *   (e a chamada pode ser contra conta de teste OU de produção)
 *
 * Ou seja: com o token no nível "Conta de teste" — que NÃO lê a conta real —
 * a chamada volta com `DEVELOPER_TOKEN_NOT_APPROVED`, e isso é SUCESSO para
 * o nosso objetivo. Tratar esse erro como falha seria o bug óbvio aqui, daí
 * `classifyAssociationResponse` existir e ser testada.
 *
 * Ver docs/google-ads-api-setup.md.
 */

/**
 * Como interpretar a resposta da chamada de associação.
 *
 * `matchedCode` carrega o código de erro que a classificação de fato casou
 * (`undefined` quando nada casou e a decisão veio só do HTTP status). Existe
 * para que um segundo consumidor possa ramificar por código SEM ter que fazer
 * regex em `reason` — `reason` é prosa para humano e pode ser reescrita a
 * qualquer momento; casar contra ela recriaria o acoplamento que o tipo
 * deveria impedir.
 */
export type AssociationOutcome =
  | { kind: "associated"; reason: string; matchedCode?: string }
  | { kind: "inconclusive"; reason: string; matchedCode?: string };

/**
 * Erros da Google Ads API que provam que a requisição CHEGOU autenticada e
 * foi processada pelo serviço — que é tudo que a associação exige. Cada um
 * só é emitido depois que o par (developer token, credencial OAuth) foi
 * lido e atribuído ao projeto.
 */
const ERRORS_THAT_STILL_ASSOCIATE = [
  // Token no nível "Conta de teste" batendo em conta de produção — o caso
  // esperado enquanto o Basic Access não sai.
  "DEVELOPER_TOKEN_NOT_APPROVED",
  // Token válido, mas a conta não está sob a MCC informada / sem permissão.
  "USER_PERMISSION_DENIED",
  "CUSTOMER_NOT_FOUND",
  "NOT_ADS_USER",
  // Cota/limite: a requisição foi aceita e contabilizada.
  "RESOURCE_EXHAUSTED",
  "QUOTA_ERROR",
];

/**
 * Erros que indicam que a requisição NÃO chegou a ser atribuída ao projeto —
 * credencial malformada, token inexistente, API desativada. Nesses casos a
 * associação provavelmente não aconteceu e insistir é o certo.
 */
const ERRORS_THAT_DO_NOT_ASSOCIATE = [
  "DEVELOPER_TOKEN_PROHIBITED",
  "INVALID_DEVELOPER_TOKEN",
  "DEVELOPER_TOKEN_PARAMETER_MISSING",
  "OAUTH_TOKEN_INVALID",
  "OAUTH_TOKEN_EXPIRED",
  "OAUTH_TOKEN_REVOKED",
  "OAUTH_TOKEN_HEADER_INVALID",
  "SERVICE_DISABLED",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
];

/**
 * Classifica o resultado bruto de uma chamada de associação.
 *
 * `status` é o HTTP status; `body` é o corpo (texto) devolvido. Não lança:
 * qualquer coisa que não case com uma lista conhecida vira `inconclusive`
 * com o motivo legível, nunca um `associated` otimista — declarar sucesso
 * sem evidência é exatamente o erro que faria alguém esperar semanas por uma
 * fila que nunca começou.
 */
export function classifyAssociationResponse(status: number, body: string): AssociationOutcome {
  if (status >= 200 && status < 300) {
    return {
      kind: "associated",
      reason: "a chamada foi aceita (HTTP 2xx) — token associado ao projeto",
    };
  }

  const codes = extractErrorCodes(body);

  // ORDEM IMPORTA, e é o inverso do intuitivo: o BLOQUEANTE vence. Um corpo
  // pode trazer os dois (ex: token OAuth revogado + token de nível teste, ou
  // um código citado de passagem dentro de uma `message`). Se qualquer código
  // bloqueante está presente, a requisição pode não ter sido atribuída — e
  // declarar "associado" nesse caso é exatamente o falso sucesso que este
  // módulo existe pra impedir. Na dúvida, fail-closed.
  const blocking = ERRORS_THAT_DO_NOT_ASSOCIATE.find((code) => codes.includes(code));
  if (blocking) {
    return {
      kind: "inconclusive",
      matchedCode: blocking,
      reason:
        `a API respondeu ${blocking} (HTTP ${status}) — a requisição não chegou a ser ` +
        "atribuída ao projeto (credencial ou token inválido / API desativada). Corrigir e repetir.",
    };
  }

  const associating = ERRORS_THAT_STILL_ASSOCIATE.find((code) => codes.includes(code));
  if (associating) {
    return {
      kind: "associated",
      matchedCode: associating,
      reason:
        `a API respondeu ${associating} (HTTP ${status}) — a requisição foi processada ` +
        "com o developer token e a credencial OAuth deste projeto, que é o que a " +
        "associação exige. A doc diz explicitamente que a chamada pode falhar.",
    };
  }

  if (status === 401 || status === 403) {
    return {
      kind: "inconclusive",
      reason:
        `HTTP ${status} sem código de erro reconhecido — provável problema de credencial. ` +
        "Conferir o corpo da resposta antes de assumir que associou.",
    };
  }

  return {
    kind: "inconclusive",
    reason: `HTTP ${status} com corpo não reconhecido — não dá pra afirmar que associou.`,
  };
}

/**
 * Extrai os códigos de erro de um corpo da Google Ads API.
 *
 * Caminho preferido: parsear o JSON e colher os VALORES de qualquer campo
 * `errorCode` aninhado (`error.details[].errors[].errorCode.{algumTipo}`), que
 * é onde o código real mora. Isso evita o falso positivo do `includes()` cru
 * sobre o corpo inteiro — um código citado dentro de uma `message` em prosa
 * não é o código do erro, e tratá-lo como tal pode inverter a classificação.
 *
 * Fallback: se o corpo não for JSON (HTML de proxy, texto solto, corpo
 * vazio), varre o texto em maiúsculas. Pior, mas melhor que cegar.
 */
export function extractErrorCodes(body: string): string[] {
  try {
    const parsed: unknown = JSON.parse(body);
    const found: string[] = [];

    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "errorCode" && value !== null && typeof value === "object") {
          for (const code of Object.values(value as Record<string, unknown>)) {
            if (typeof code === "string") found.push(code.toUpperCase());
          }
        } else {
          walk(value);
        }
      }
    };

    walk(parsed);
    if (found.length > 0) return found;
    // JSON válido mas sem `errorCode` estruturado (formato inesperado): cai
    // no texto, em vez de devolver lista vazia e classificar como desconhecido.
  } catch {
    // corpo não-JSON — segue pro fallback textual.
  }

  const upper = body.toUpperCase();
  return [...ERRORS_THAT_DO_NOT_ASSOCIATE, ...ERRORS_THAT_STILL_ASSOCIATE].filter((code) =>
    upper.includes(code),
  );
}

/** Config mínima para montar a chamada. */
export interface AssociationRequestConfig {
  apiVersion: string;
  /** Conta cujos dados a query pede — a de anunciante, sem hífens. */
  customerId: string;
  /** MCC que detém o developer token, sem hífens. */
  loginCustomerId: string;
}

/**
 * URL e corpo da chamada de associação. Query mínima de propósito: o objetivo
 * é fazer UMA requisição atribuível, não trazer dados — quanto menor, menor a
 * chance de falhar por um motivo que confunda o diagnóstico.
 */
export function buildAssociationRequest(config: AssociationRequestConfig): {
  url: string;
  body: string;
} {
  return {
    url: `https://googleads.googleapis.com/${config.apiVersion}/customers/${config.customerId}/googleAds:searchStream`,
    body: JSON.stringify({ query: "SELECT customer.id FROM customer LIMIT 1" }),
  };
}

/** Remove hífens/espaços de um CID (`623-609-4249` → `6236094249`). */
export function normalizeCustomerId(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}
