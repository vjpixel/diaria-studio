/**
 * reativar-token.ts (#8194)
 *
 * Token assinado do botão "Confirmar minha inscrição" do e-mail da Brevo
 * diária (`data/snippets/brevo-diaria-pending-intro.md`). Com ele, o clique no
 * link vale como confirmação: o worker `reativar` ativa o assinante direto no
 * Kit, sem disparar o e-mail de confirmação (DOI, #7723).
 *
 * Por que prova posse da caixa: o token só chega pela merge tag
 * `{{ contact.REATIVAR_TOKEN }}` no e-mail entregue ao próprio endereço, e não
 * pode ser gerado sem `REATIVAR_SECRET`. Um link montado à mão com o e-mail de
 * outra pessoa não tem token válido e cai no fluxo DOI de sempre.
 *
 * Verificação STATELESS: e-mail e token vêm juntos na URL, o worker recalcula
 * o HMAC. Sem KV (diferente do `POLL_TOKEN`, que esconde o e-mail da URL).
 *
 * Riscos aceitos pelo editor (#8194): encaminhamento (quem recebe a edição
 * encaminhada confirma o dono original) e scanners de link que abrem o GET.
 *
 * **Fronteira `lib/shared/` (#2747):** só Web Crypto — roda igual em Node
 * (injeção) e no worker `reativar`, que importa este arquivo direto.
 */

/** Atributo de contato Brevo que carrega o token. */
export const REATIVAR_TOKEN_ATTR = "REATIVAR_TOKEN";

/** 32 hex chars = 128 bits do HMAC-SHA256. */
const TOKEN_HEX_LEN = 32;

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Token determinístico pro par (secret, e-mail normalizado). */
export async function computeReativarToken(secret: string, email: string): Promise<string> {
  const full = await hmacHex(secret, `reativar:${email.trim().toLowerCase()}`);
  return full.slice(0, TOKEN_HEX_LEN);
}

/**
 * `true` só se `token` é exatamente o token de `email` sob `secret`. Secret
 * ausente/vazio, token ausente ou malformado → `false` (o caller cai no DOI).
 * Comparação em tempo constante sobre strings de mesmo tamanho.
 */
export async function verifyReativarToken(
  secret: string | undefined,
  email: string,
  token: string | null | undefined,
): Promise<boolean> {
  if (!secret || !token) return false;
  const candidate = token.trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${TOKEN_HEX_LEN}}$`).test(candidate)) return false;
  const expected = await computeReativarToken(secret, email);
  let diff = 0;
  for (let i = 0; i < TOKEN_HEX_LEN; i++) diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
  return diff === 0;
}
