/**
 * scripts/lib/shared/secret-compare.ts (#10082)
 *
 * Comparação de segredo em tempo constante, compatível com Workers (o runtime
 * não tem `timingSafeEqual`). Mesmo método de
 * `workers/brevo-dashboard/src/index.ts` e `workers/diaria-dashboard/src/index.ts`
 * (#3081): SHA-256 dos dois lados (tamanho fixo) e XOR dos digests, sem sair
 * no primeiro byte diferente. Essas duas cópias antigas não foram migradas
 * para cá; código novo importa daqui.
 */

export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/**
 * Confere um segredo recebido contra o configurado. Fail-closed: segredo não
 * configurado (ausente ou vazio) nunca autoriza, nem com valor vazio do outro
 * lado.
 */
export async function secretMatches(received: string | null | undefined, configured: string | undefined): Promise<boolean> {
  if (!configured || !received) return false;
  return timingSafeEqualStr(received, configured);
}
