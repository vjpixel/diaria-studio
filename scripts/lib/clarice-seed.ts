/**
 * clarice-seed.ts — constante e helper de injeção de seed address (#2683).
 *
 * O email do editor entra em TODA wave/lista gerada pelos builders de wave
 * (clarice-build-waves.ts e clarice-build-waves-store.ts), funcionando como
 * monitor address: o editor recebe cada envio para conferir render, inbox
 * placement (Gmail) e entregabilidade.
 *
 * Regras:
 *   - Cada wave recebe o seed exatamente 1× (dedup DENTRO da wave).
 *   - Seed já presente (editor é assinante) → apenas marca IS_SEED="true", sem duplicar.
 *   - Seed ausente → insere ao fim com IS_SEED="true".
 *   - IS_SEED="true" permite excluir a row de analytics de engajamento
 *     (priority_points, cohorts) — o editor não é leitor real.
 *
 * Nota sobre métricas: IS_SEED vira atributo de contato no Brevo (via CSV import),
 * permitindo filtros de segmento que excluam seeds dos reports de open-rate/CTR.
 * No store local (clarice_users), o editor pode ter priority_points reais se for
 * assinante — um follow-up (#2683) pode zerar/ignorar esses pontos na priorização
 * de waves, mas a injeção garantida em toda wave já resolve a necessidade imediata
 * de monitoramento. A marcação IS_SEED é o sinal rastreável para esse follow-up.
 */

type Row = Record<string, string>;

/** Email do editor / seed address fixo para monitoramento de waves. */
export const CLARICE_SEED_EMAIL = "vjpixel@gmail.com";

/** Nome para personalização nas rows injetadas. */
export const CLARICE_SEED_NOME = "Pixel";

/**
 * Garante que CLARICE_SEED_EMAIL apareça exatamente 1× em `rows` (dedup DENTRO
 * da wave), marcado com IS_SEED="true". Não muta o array original.
 *
 * @param rows       Linhas da wave (ex: output de classifyT1, w.map(…) do store).
 * @param emailKey   Nome da coluna de email (ex: "email", "e-mail").
 * @param seedDefaults Campos extras para a row INJETADA (ignorado quando o seed
 *                   já existia — só IS_SEED é adicionado nesse caso).
 *                   Exemplo: { NOME: "Pixel", RECENCY_QUARTIL: "Q1" }.
 */
export function injectSeed(
  rows: Row[],
  emailKey: string,
  seedDefaults: Record<string, string> = {},
): Row[] {
  const seedEmail = CLARICE_SEED_EMAIL.toLowerCase();
  const result = rows.map((r) => ({ ...r })); // clone raso — não muta original

  const idx = result.findIndex(
    (r) => (r[emailKey] ?? "").trim().toLowerCase() === seedEmail,
  );

  if (idx >= 0) {
    // Já presente: apenas marca IS_SEED (não duplica).
    result[idx] = { ...result[idx], IS_SEED: "true" };
  } else {
    // Ausente: insere ao fim com defaults + IS_SEED.
    result.push({
      ...seedDefaults,
      [emailKey]: CLARICE_SEED_EMAIL,
      IS_SEED: "true",
    });
  }

  return result;
}
