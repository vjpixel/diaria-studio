/**
 * lint-checks/title-limits.ts (#11254)
 *
 * Os dois limites REAIS do título de destaque, cada um com a sua razão de
 * existir (decisão do editor no briefing overnight 261027d):
 *
 * 1. `title-card-4x5` — todo título de destaque (D1/D2/D3, todas as opções)
 *    tem de caber no card 4x5 diário (`04-d{N}-4x5.jpg`) em até 3 linhas a
 *    62px. O critério é o MESMO que `gen-social-card-4x5.ts` usa para abortar
 *    antes de renderizar (`dailyCardTitleFits`, de `lib/card-title-wrap.ts`,
 *    que os dois importam), nunca reimplementado: um título que este check aprova é um título que o
 *    gerador do card aceita. Não é contagem de caracteres: depende de como as
 *    palavras quebram (na edição 261027 um título de 72 chars coube; um de 80,
 *    não).
 * 2. `title-email-subject` — o título do D1 vira o assunto do e-mail
 *    (`buildKitSubject` em `publish-newsletter-kit.ts`, mesmo caminho do
 *    Beehiiv via `insert-titulo-subtitulo.ts`). Acima de ~60-70 caracteres o
 *    assunto trunca na caixa de entrada; o teto é `MAX_SUBJECT_LENGTH` (70).
 *    Só o D1 conta: D2/D3 nunca são assunto.
 *
 * Substituem o antigo teto fixo de 52 caracteres (`title-length.ts`), que não
 * tinha justificativa documentada. O nome `--check title-length` continua
 * aceito e roda os dois (`checkTitleLimits`), para não quebrar quem já o
 * chama no Stage 2.
 *
 * **Fora do gate 4.** `check-invariants --stage 4` não roda nenhum dos dois, e
 * no painel de revisão do Studio eles aparecem como aviso, nunca bloqueio: o
 * editor pode alongar o título no gate. Bloqueiam só no Stage 2 (saída do
 * writer, `invariant-checks/stage-2.ts`), quando reescrever ainda é barato. O
 * card continua protegido no Stage 3 pelo próprio gerador, que aborta.
 */

// Do módulo puro, não de `gen-social-card-4x5.ts`: o gerador traz o `sharp`,
// e este lint roda no Stage 2 e no painel do Studio (#11329 item 4).
import { dailyCardTitleFits } from "../card-title-wrap.ts";
import { collectDestaqueTitleCandidates, graphemeLength } from "./title-length.ts";

/** Teto do assunto do e-mail (título do D1), em grafemas. Faixa do editor: ~60-70. */
export const MAX_SUBJECT_LENGTH = 70;

export type TitleLimitKind = "card-4x5" | "email-subject";

export interface TitleLimitError {
  kind: TitleLimitKind;
  destaque: number;
  category: string;
  title: string;
  length: number;
  /** Só para `email-subject`: o teto em grafemas. `null` no card (não é contagem). */
  max: number | null;
}

export interface TitleLimitReport {
  ok: boolean;
  errors: TitleLimitError[];
}

function report(errors: TitleLimitError[]): TitleLimitReport {
  return { ok: errors.length === 0, errors };
}

/** Todo título de destaque cabe no card 4x5 diário (≤3 linhas a 62px). */
export function checkTitleCardFit(md: string): TitleLimitReport {
  const errors: TitleLimitError[] = [];
  for (const c of collectDestaqueTitleCandidates(md)) {
    if (!dailyCardTitleFits(c.title)) {
      errors.push({ kind: "card-4x5", ...c, length: graphemeLength(c.title), max: null });
    }
  }
  return report(errors);
}

/** O título do D1 (assunto do e-mail) tem no máximo `MAX_SUBJECT_LENGTH` grafemas. */
export function checkTitleEmailSubject(md: string): TitleLimitReport {
  const errors: TitleLimitError[] = [];
  for (const c of collectDestaqueTitleCandidates(md)) {
    if (c.destaque !== 1) continue;
    const length = graphemeLength(c.title);
    if (length > MAX_SUBJECT_LENGTH) {
      errors.push({ kind: "email-subject", ...c, length, max: MAX_SUBJECT_LENGTH });
    }
  }
  return report(errors);
}

/** Os dois checks juntos — o que `--check title-length` roda desde o #11254. */
export function checkTitleLimits(md: string): TitleLimitReport {
  return report([...checkTitleCardFit(md).errors, ...checkTitleEmailSubject(md).errors]);
}

/** Linha legível de um erro, para os CLIs. */
export function formatTitleLimitError(e: TitleLimitError): string {
  const what = e.kind === "card-4x5"
    ? "não cabe no card 4x5 (3 linhas a 62px)"
    : `assunto do e-mail com ${e.length} chars (máx ${e.max})`;
  return `DESTAQUE ${e.destaque} (${e.category}): ${what} — "${e.title}"`;
}
