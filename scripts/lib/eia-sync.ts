/**
 * scripts/lib/eia-sync.ts (#5459)
 *
 * `stitch-newsletter.ts::readEiaBlock` copia o bloco `**É IA?**` de
 * `01-eia.md` VERBATIM pro mirror em `02-draft.md`/`02-reviewed.md`. No
 * momento do stitch os dois batem — mas depois disso `02-reviewed.md` passa
 * por humanizador + Clarice (Stage 2, escopo full-document, sem exclusão de
 * seção — ver `orchestrator-stage-2.md` §2b/§2c), que podem reescrever o
 * bloco É IA? dentro do corpo da newsletter. `01-eia.md`, por outro lado,
 * NUNCA é re-processado por nenhum dos dois — é gerado uma vez no Stage 1/3 e
 * nunca mais tocado.
 *
 * `checkEiaCreditSynced` (#3825, `invariant-checks/stage-4.ts`) já DETECTA
 * essa divergência, mas só no Stage 4, warning-only, sem nunca corrigir —
 * sempre exigindo fix manual em `01-eia.md` (o REAL, que
 * `render-newsletter-html.ts`/`extractContent` de fato leem; editar só
 * `02-reviewed.md` não tem efeito nenhum no e-mail publicado).
 *
 * Este módulo fecha esse loop automaticamente, no momento certo do pipeline
 * (logo após humanizador+Clarice rodarem sobre `02-reviewed.md`, Stage 2,
 * ANTES do Stage 4 nunca ver a divergência): compara o bloco mirror já
 * corrigido em `02-reviewed.md` contra `01-eia.md`, e — se divergir —
 * devolve `01-eia.md` já sincronizado com a versão corrigida. Mesma direção
 * do fix manual do #3825 (o real ganha o valor do mirror, nunca o
 * contrário — o editor edita o mirror porque é a aba que o Studio abre),
 * só que automatizado.
 *
 * **Alternativa explicitamente descartada pela issue #5459:** excluir o
 * bloco É IA? do escopo de reescrita do Clarice/humanizador. Isso deixaria a
 * legenda mostrada ao editor no gate diferente da real — pior pra revisão.
 * Não implementar essa alternativa aqui nem em nenhum outro ponto do
 * pipeline.
 *
 * Reusa a MESMA lógica de extração/parsing de `checkEiaCreditSynced`
 * (`extractEiaMirrorBlock` + `parseEIA`/`parseEiaMirrorBlock` de
 * `newsletter-parse.ts`) — garante que qualquer divergência detectada aqui é
 * de CONTEÚDO, não de regra de parsing diferente entre os dois módulos.
 */
import { extractEiaMirrorBlock, parseEIA, parseEiaMirrorBlock } from "./newsletter-parse.ts";

/** Mesmo regex usado por `stitch-newsletter.ts::readEiaBlock` pra stripar o
 * frontmatter YAML (`eia_answer:`) antes de copiar o corpo pro mirror. Usado
 * aqui em sentido inverso: preservar o frontmatter de `01-eia.md` intacto ao
 * regravar só o corpo. */
const FRONTMATTER_RE = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/;

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function normalizeLine(s?: string): string {
  return s ? normalize(s) : "";
}

export interface EiaSyncResult {
  /** `true` quando o mirror pós-correção divergia de `01-eia.md` e
   * `newEiaMd` traz a versão sincronizada. `false` = no-op (sem mirror em
   * `reviewedMdText`, ou os dois já batiam) — `newEiaMd` é `eiaMdText`
   * inalterado. */
  changed: boolean;
  newEiaMd: string;
  /** Motivo do no-op, só presente quando `changed` é `false` — útil pro
   * wrapper de CLI logar sem precisar re-derivar. */
  reason?: "no-mirror" | "already-synced";
}

/**
 * Pure. Compara o bloco `**É IA?**` mirror extraído de `reviewedMdText`
 * (já pós-humanizador+Clarice) contra o corpo de `eiaMdText` — mesmos campos
 * que `checkEiaCreditSynced` compara (`credit` + `prevResultLine`,
 * normalizados por whitespace). Se divergir, retorna `01-eia.md`
 * sincronizado: frontmatter original preservado + corpo substituído pelo
 * bloco mirror (já trimado por `extractEiaMirrorBlock`).
 *
 * `editionDir` só é usado por `parseEIA`/`parseEiaMirrorBlock` pra extrair o
 * código AAMMDD do path e resolver as imagens A/B (`imageA`/`imageB`) — não
 * lê nada do disco além do que os dois textos já trazem; ambos os campos são
 * ignorados na comparação de sync (só `credit`/`prevResultLine` importam
 * aqui, mesmo escopo do #3825).
 */
export function syncEiaBlockFromReviewed(
  eiaMdText: string,
  reviewedMdText: string,
  editionDir: string,
): EiaSyncResult {
  const mirrorBlock = extractEiaMirrorBlock(reviewedMdText);
  if (!mirrorBlock) {
    return { changed: false, newEiaMd: eiaMdText, reason: "no-mirror" };
  }

  const real = parseEIA(eiaMdText, editionDir);
  const mirror = parseEiaMirrorBlock(mirrorBlock, editionDir);

  const creditDiverges = normalize(real.credit) !== normalize(mirror.credit);
  const prevResultDiverges =
    normalizeLine(real.prevResultLine) !== normalizeLine(mirror.prevResultLine);

  if (!creditDiverges && !prevResultDiverges) {
    return { changed: false, newEiaMd: eiaMdText, reason: "already-synced" };
  }

  const fmMatch = eiaMdText.match(FRONTMATTER_RE);
  const frontmatter = fmMatch ? fmMatch[0] : "";
  const newEiaMd = `${frontmatter}${mirrorBlock.trim()}\n`;

  return { changed: true, newEiaMd };
}
