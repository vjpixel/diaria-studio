/**
 * annual-paths.ts (#7569)
 *
 * Paths da edição anual. Espelha `lib/mensal/monthly-paths.ts` em papel, mas
 * é deliberadamente MENOR: a mensal carrega compat de dois formatos de ciclo
 * (`YYMM` legado e `YYMM-MM`) porque tem pastas históricas em disco; a anual
 * nasce com um formato só e não deve herdar essa dívida.
 *
 * Layout: `data/annual/{AAAA}-{tipo}/` — ex. `data/annual/2026-aniversario/`,
 * `data/annual/2026-janeiro/`. `AAAA` é o ano que a retrospectiva FECHA (o do
 * último mês da janela), não o ano em que a edição é enviada: a rodada de
 * janeiro/2027 cobre 2026 e mora em `2026-janeiro/`.
 *
 * Convenção `_internal/` (#959): tudo que é insumo de pipeline (JSONs de
 * estado, prompts, pré-render) fica sob `_internal/`; só o que o editor
 * revisa/edita (`draft.md`, `prioritized.md`, imagens) fica na raiz.
 */

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnnualTipo, AnnualWindow } from "./annual-window.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const ANNUAL_BASE = resolve(ROOT, "data/annual");

/** Rótulo do diretório da edição: `{AAAA}-{tipo}`. */
export function annualSlug(year: number, tipo: AnnualTipo): string {
  return `${year}-${tipo}`;
}

/** Mesmo rótulo, derivado de uma janela já resolvida. */
export function annualSlugFor(window: Pick<AnnualWindow, "year" | "tipo">): string {
  return annualSlug(window.year, window.tipo);
}

/** Diretório da edição anual. */
export function annualDir(slug: string, base: string = ANNUAL_BASE): string {
  return join(base, slug);
}

/** Diretório `_internal/` da edição anual. */
export function annualInternalDir(slug: string, base: string = ANNUAL_BASE): string {
  return join(annualDir(slug, base), "_internal");
}

/** Caminhos nomeados — evita string literal espalhada por script e skill. */
export function annualPaths(slug: string, base: string = ANNUAL_BASE) {
  const dir = annualDir(slug, base);
  const internal = annualInternalDir(slug, base);
  return {
    dir,
    internal,
    /** Insumo consolidado da Etapa 1 (destaques da janela, já filtrados). */
    rawDestaques: join(internal, "raw-destaques.json"),
    /** Manifesto da coleta: fonte e contagem por mês (auditoria do gate). */
    collectReport: join(internal, "01-collect-report.json"),
    /** Saída do `analyst-anual` — revisada pelo editor. */
    prioritized: join(dir, "prioritized.md"),
    /** Saída do `writer-anual` — o texto da edição. */
    draft: join(dir, "draft.md"),
    /** Subject escolhido (invariante do ASSUNTO, espelhando a mensal). */
    chosenSubject: join(internal, "02-chosen-subject.txt"),
    /** Pré-render pro preview local e pro envio. */
    previewHtml: join(internal, "04-preview.html"),
    previewEmbedded: join(internal, "04-preview-embedded.html"),
    previewServerUrl: join(internal, "preview-server-url.json"),
    publicImages: join(internal, "public-images.json"),
    factCheck: join(internal, "04-fact-check.json"),
    published: join(internal, "05-published.json"),
  };
}

/** Prompt de imagem do tema N (1-based), gerado pelo `writer-anual`. */
export function annualThemePromptPath(slug: string, n: number, base: string = ANNUAL_BASE): string {
  return join(annualInternalDir(slug, base), `02-d${n}-prompt.md`);
}

/** Imagem 2:1 do tema N (1-based). */
export function annualThemeImagePath(slug: string, n: number, base: string = ANNUAL_BASE): string {
  return join(annualDir(slug, base), `04-d${n}-2x1.jpg`);
}
