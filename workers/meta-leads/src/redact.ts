/**
 * workers/meta-leads/src/redact.ts (#7769, achado P2/alta do review da PR #7777)
 *
 * O corpo de erro devolvido por Kit/Graph é embutido no `reason`, que vai
 * pro `console.error` e pro corpo da resposta HTTP. Erro de validação do
 * Kit costuma ECOAR o e-mail submetido ("email: 'x@y.com' is invalid"), e
 * `wrangler.toml` usa `head_sampling_rate = 1` — ou seja, 100% dos logs
 * retidos. Sem esta camada, PII de lead vazaria pro Cloudflare Logs em todo
 * caminho de falha.
 *
 * A redação é feita SOBRE O TEXTO DE TERCEIRO, nunca sobre o dado que nós
 * mesmos montamos: o objetivo é poder logar a mensagem de erro do provedor
 * (que é o que torna a falha diagnosticável) sem carregar junto o
 * identificador do lead.
 */

/** E-mail em texto livre. Deliberadamente permissivo no local-part: a meta é
 *  redigir agressivamente, não validar endereço — um falso positivo aqui só
 *  torna a mensagem de erro um pouco mais opaca, enquanto um falso negativo
 *  vaza PII. */
const EMAIL_RE = /[^\s"'<>@,;:()[\]{}]+@[^\s"'<>@,;:()[\]{}]+\.[A-Za-z]{2,}/g;

/** Telefone: 8+ dígitos seguidos, tolerando separadores comuns. Formulário
 *  instantâneo da Meta oferece campo de telefone, então ele pode aparecer no
 *  eco de erro pelo mesmo caminho do e-mail. */
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;

/**
 * Remove PII reconhecível de um texto vindo de terceiro, preservando o
 * suficiente pra diagnosticar (código de erro, campo, mensagem).
 *
 * @param text  Corpo de resposta de Kit/Graph, cru.
 * @returns     Mesmo texto com e-mails e telefones substituídos por marcador.
 */
export function redactPii(text: string): string {
  return text.replace(EMAIL_RE, "[email redigido]").replace(PHONE_RE, "[telefone redigido]");
}
