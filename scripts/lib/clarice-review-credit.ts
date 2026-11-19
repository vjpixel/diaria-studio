/**
 * clarice-review-credit.ts (#13711) — a frase "A revisão foi feita pelo MCP da
 * Clarice (...)" do PARA ENCERRAR só vale quando a Clarice revisou a edição.
 *
 * O parágrafo de ferramentas vem do snippet `data/snippets/encerramento-social-apoio.md`
 * (fallback `FIXED_BLOCKS.para_encerrar_tools` em `stitch-newsletter.ts`) e
 * afirma a revisão em toda edição. Quando a Clarice cai (marcador
 * `_internal/02-clarice-pending.json`, #12257) e o editor publica sem ela, a
 * newsletter afirma ao leitor uma revisão que não aconteceu (edição 261119).
 *
 * Premissa (#13711, registrada na PR): com o marcador ativo, o RENDER omite a
 * oração da Clarice, com o link de afiliado dela; sem marcador, nada muda. O
 * `02-reviewed.md` fica intacto (o editor pode ter editado o rodapé à mão,
 * #495/#7401): a troca acontece em `extractContent`, de onde saem o preview do
 * gate 4, o HTML do Kit e os demais renders. Quando a Clarice é retomada com
 * sucesso (`clarice-pending.ts resume`), o marcador sai e a frase volta.
 *
 * Mesmo desenho de `shared/sending-platform-credit.ts` (#6195): âncora no LINK
 * de afiliado (`clarice.ai`), não na copy, porque o humanizador e a própria
 * Clarice reescrevem a prosa do parágrafo.
 */

/**
 * Oração que credita a revisão à Clarice: do início da frase até o link
 * `clarice.ai` entre parênteses, com o separador que vem depois (`, ` quando a
 * frase continua, `.` quando termina ali). Exige "revis" na oração para não
 * casar outra menção à Clarice com o mesmo link (o box 📣 de divulgação).
 *
 * Grupos: 1 = fronteira antes da frase (início ou `. `), 2 = separador depois.
 */
export const CLARICE_REVIEW_CREDIT_RE =
  /(^|[.!?]\s+)[^.!?\n]*?\brevis[ãa]o\b[^.!?\n]*?\bClarice\b[^.!?\n(]*?\(\s*\[[^\]]*\]\(\s*https?:\/\/(?:www\.)?clarice\.ai[^)]*\)\s*\)([ \t]*,[ \t]*(?:e[ \t]+)?|[ \t]*[.!?])?[ \t]*/gim;

export interface OmitClariceCreditResult {
  markdown: string;
  /** `true` quando alguma oração da Clarice saiu do texto. */
  omitido: boolean;
}

/** Marca interna: "a letra que vem a seguir abre a frase". Nunca sobra no texto. */
const CAP_MARK = "\u0000";

/**
 * Tira do markdown a oração que credita a revisão à Clarice. Quando a frase
 * continua depois da oração (", dei o toque final e enviei..."), o resto vira
 * a frase, com a inicial maiúscula. Idempotente: sem o link da Clarice, o
 * texto sai intacto e `omitido: false`.
 */
export function omitClariceReviewCredit(markdown: string): OmitClariceCreditResult {
  let omitido = false;
  const out = markdown.replace(
    CLARICE_REVIEW_CREDIT_RE,
    (m: string, before: string, sep: string | undefined, offset: number, whole: string) => {
      omitido = true;
      // A frase segue depois da oração: o que vem depois passa a abri-la.
      if (sep?.includes(",")) return before + CAP_MARK;
      // A oração era a frase inteira. Se era a última do parágrafo, o espaço
      // depois do ponto anterior também sai.
      const after = whole.slice(offset + m.length);
      return after === "" || after.startsWith("\n") ? before.trimEnd() : before;
    },
  );
  if (!omitido) return { markdown, omitido };
  const capitalized = out
    .replace(new RegExp(`${CAP_MARK}(\\p{Ll})`, "gu"), (_m, ch: string) => ch.toUpperCase())
    .split(CAP_MARK).join("");
  return { markdown: capitalized, omitido };
}

/** O texto ainda credita a revisão à Clarice? (usado pelo invariante do gate 4) */
export function hasClariceReviewCredit(markdown: string): boolean {
  CLARICE_REVIEW_CREDIT_RE.lastIndex = 0;
  const found = CLARICE_REVIEW_CREDIT_RE.test(markdown);
  CLARICE_REVIEW_CREDIT_RE.lastIndex = 0;
  return found;
}
