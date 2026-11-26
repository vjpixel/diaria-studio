/**
 * scripts/lib/eia-sync.ts (#5459)
 *
 * `stitch-newsletter.ts::readEiaBlock` copia o bloco `**É IA?**` de
 * `01-eia.md` VERBATIM pro mirror em `02-draft.md`/`02-reviewed.md`. No
 * momento do stitch os dois batem — mas depois disso `02-reviewed.md` passa
 * por humanizador + Clarice (Stage 2, escopo full-document, sem exclusão de
 * seção — ver `orchestrator-stage-2-fallback.md` §2b/§2c), que podem reescrever o
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

/** Sentinela do placeholder que `stitch-newsletter.ts::readEiaBlock` grava
 * no mirror quando `01-eia.md` ainda não existe no momento do stitch
 * ("É IA?\n\n[É IA? ainda processando — bloco será inserido na Etapa 3]").
 *
 * #13886: casar a frase com o travessão literal falhava depois do
 * `strip-emdashes-reviewed.ts` (#9379), que roda ANTES deste sync e troca o
 * ` — ` do placeholder por vírgula ("[É IA? ainda processando, bloco será
 * inserido na Etapa 3]"). Sem casar, o placeholder era tratado como legenda
 * corrigida e sobrescrevia o `01-eia.md` real (edição 261124: sumiram a
 * legenda do Wikimedia e o "Resultado da última edição"). Por isso a
 * sentinela é só "ainda processando", tolerante a qualquer separador, a
 * caixa e a whitespace: nenhuma legenda real de É IA? traz essa frase. */
const EIA_PLACEHOLDER_RE = /ainda\s+processando/i;

/**
 * #5459 review (PR #5466): guarda contra a race onde `eia-composer` termina
 * DURANTE o Stage 2 — criando `01-eia.md` real DEPOIS do stitch (que gravou
 * o placeholder no mirror) mas ANTES desta sync rodar. Sem este guard, o
 * mirror (placeholder) diverge de `01-eia.md` (crédito real) e o sync
 * regrava o placeholder por cima do crédito real — perda de dado. Se o
 * mirror extraído é o próprio placeholder, não há correção pós-Clarice pra
 * propagar: é sempre no-op.
 */
export function isPlaceholderMirror(block: string): boolean {
  return EIA_PLACEHOLDER_RE.test(normalize(block));
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
  reason?: "no-mirror" | "already-synced" | "mirror-is-placeholder" | "mirror-loses-content";
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

  if (isPlaceholderMirror(mirrorBlock)) {
    return { changed: false, newEiaMd: eiaMdText, reason: "mirror-is-placeholder" };
  }

  const real = parseEIA(eiaMdText, editionDir);
  const mirror = parseEiaMirrorBlock(mirrorBlock, editionDir);

  const creditDiverges = normalize(real.credit) !== normalize(mirror.credit);
  const prevResultDiverges =
    normalizeLine(real.prevResultLine) !== normalizeLine(mirror.prevResultLine);

  if (!creditDiverges && !prevResultDiverges) {
    return { changed: false, newEiaMd: eiaMdText, reason: "already-synced" };
  }

  // #13886: o sentido 02→01 existe para propagar a correção de texto que o
  // humanizador/Clarice fizeram no mirror, nunca para APAGAR conteúdo do real.
  // Mirror sem legenda (ou sem a linha "Resultado da última edição") contra um
  // 01-eia.md que a tem não é correção: é mirror defasado/quebrado. Recusa
  // (no-op) e o CLI sai ≠ 0 apontando o `--from 01`.
  const realHasCredit = normalize(real.credit) !== "";
  const mirrorHasCredit = normalize(mirror.credit) !== "";
  const dropsCredit = realHasCredit && !mirrorHasCredit;
  const dropsPrevResult = !!normalizeLine(real.prevResultLine) && !normalizeLine(mirror.prevResultLine);
  if (dropsCredit || dropsPrevResult) {
    return { changed: false, newEiaMd: eiaMdText, reason: "mirror-loses-content" };
  }

  const fmMatch = eiaMdText.match(FRONTMATTER_RE);
  const frontmatter = fmMatch ? fmMatch[0] : "";
  const newEiaMd = `${frontmatter}${mirrorBlock.trim()}\n`;

  return { changed: true, newEiaMd };
}

/** `true` quando o corpo de `01-eia.md` (sem frontmatter) tem legenda real:
 * não vazio e não o placeholder. Usado pelo CLI para decidir se o no-op de
 * mirror-placeholder é inofensivo (01 ainda não existe/vazio, ordem normal do
 * Stage 2) ou uma recusa que precisa sair ≠ 0 (#13886). */
export function eiaMdHasRealContent(eiaMdText: string): boolean {
  const body = eiaMdText.replace(FRONTMATTER_RE, "").trim();
  if (!body) return false;
  return !isPlaceholderMirror(body);
}

export interface EiaMirrorFromEiaResult {
  /** `true` quando `newReviewedMd` traz o mirror trocado pelo corpo de
   * `01-eia.md`. */
  changed: boolean;
  newReviewedMd: string;
  reason?: "no-mirror" | "already-synced" | "eia-empty";
}

/**
 * Pure. Sentido INVERSO do `syncEiaBlockFromReviewed` (#13886, `--from 01`):
 * espelha o corpo de `01-eia.md` (a fonte real do render) no bloco
 * `**É IA?**` de `02-reviewed.md`. É o fix do invariante `eia-credit-synced`
 * quando o 01 está certo e o mirror está defasado (placeholder do stitch,
 * mirror anterior à Etapa 3). Mesmo corpo que `stitch-newsletter.ts::
 * readEiaBlock` grava: frontmatter removido, `trim()`.
 *
 * Só toca o bloco mirror; o resto de `02-reviewed.md` sai byte-idêntico
 * (CRLF preservado quando o arquivo usa CRLF).
 */
export function syncReviewedMirrorFromEia(eiaMdText: string, reviewedMdText: string): EiaMirrorFromEiaResult {
  const body = eiaMdText.replace(FRONTMATTER_RE, "").trim();
  if (!body || isPlaceholderMirror(body)) {
    return { changed: false, newReviewedMd: reviewedMdText, reason: "eia-empty" };
  }
  const usesCrlf = reviewedMdText.includes("\r\n");
  const text = reviewedMdText.replace(/\r\n/g, "\n");
  const mirrorBlock = extractEiaMirrorBlock(text);
  if (!mirrorBlock) {
    return { changed: false, newReviewedMd: reviewedMdText, reason: "no-mirror" };
  }
  const bodyLf = body.replace(/\r\n/g, "\n");
  if (mirrorBlock === bodyLf) {
    return { changed: false, newReviewedMd: reviewedMdText, reason: "already-synced" };
  }
  const idx = text.indexOf(mirrorBlock);
  if (idx < 0) {
    // extractEiaMirrorBlock devolve trecho trimado de `text`; sempre achável.
    return { changed: false, newReviewedMd: reviewedMdText, reason: "no-mirror" };
  }
  const replaced = text.slice(0, idx) + bodyLf + text.slice(idx + mirrorBlock.length);
  return { changed: true, newReviewedMd: usesCrlf ? replaced.replace(/\n/g, "\r\n") : replaced };
}
