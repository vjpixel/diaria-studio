/**
 * circle-stack-warnings.ts (#12553)
 *
 * Avisos da seleção do post semanal da Stack, RECALCULADOS a cada execução a
 * partir da seleção atual. Antes o campo `warnings` era gravado na montagem e
 * nunca revisto: depois que o editor reescrevia um título à mão, o
 * `publish-circle-stack.ts` seguia imprimindo "Título traduzido por
 * stack-title-translator — revisar" com o título antigo, inclusive no
 * `--publish` (ciclo 26w45). E "Edições sem 02-reviewed.md: 261102" saía toda
 * semana com feriado (02/11, Finados): sem edição no dia não é arquivo faltando.
 *
 * Regras:
 *   - Título traduzido: pendente só enquanto `title` é o que o tradutor gravou
 *     (`titleTranslated`; seleção antiga sem o campo = o título que aparece no
 *     aviso gravado) e sem `titleReviewed`. Título editado = revisado.
 *   - Tradução que falhou: some quando não sobra título sem sinal de português
 *     a traduzir.
 *   - Edição faltando: só a data cujo diretório da edição existe sem
 *     `02-reviewed.md`. Diretório ausente = dia sem edição (feriado, sem
 *     publicação) — não é aviso.
 *   - Destaques sem termo de interesse: recontado sobre os destaques atuais
 *     (quando eles trazem `score`).
 *   - Qualquer outro aviso gravado fica como está.
 */
import type { CircleStackItem, CircleStackSelection } from "./circle-stack-render.ts";
import {
  parseStackTitleTranslatedWarning,
  STACK_TITLE_TRANSLATION_FAILED_PREFIX,
  stackTitleTranslatedWarning,
  stackTitleTranslationCandidates,
} from "./circle-stack-translate.ts";

export const CIRCLE_STACK_MISSING_EDITIONS_PREFIX = "Edições sem 02-reviewed.md: ";
const WEAK_DESTAQUES_RE = /^\d+ destaque\(s\) sem nenhum termo de interesse da Stack/;

/** Pure: aviso de edições com diretório e sem `02-reviewed.md` (vazio = sem aviso). */
export function circleStackMissingEditionsWarning(dates: readonly string[]): string | null {
  return dates.length > 0 ? `${CIRCLE_STACK_MISSING_EDITIONS_PREFIX}${dates.join(", ")}` : null;
}

/** Pure: aviso de destaques sem nenhum termo de interesse (0 = sem aviso). */
export function circleStackWeakDestaquesWarning(count: number): string | null {
  return count > 0 ? `${count} destaque(s) sem nenhum termo de interesse da Stack — revisar a seleção` : null;
}

const SECTIONS = ["destaques", "lancamentos", "useMelhor", "radar"] as const;

export interface RefreshCircleStackWarningsOptions {
  /**
   * `true` = a data tem diretório de edição (com ou sem `02-reviewed.md`).
   * Ausente = não dá para conferir (sem `data/`): o aviso de edição faltando
   * gravado fica como está.
   */
  editionDirExists?: (aammdd: string) => boolean;
}

/**
 * Pure: avisos atuais da seleção (`sel` já com as exclusões aplicadas, #12557,
 * para item descartado não gerar aviso). `stored` são os gravados na seleção
 * (ou os da montagem, na seleção nova).
 */
export function refreshCircleStackWarnings(
  sel: CircleStackSelection,
  stored: readonly string[],
  opts: RefreshCircleStackWarningsOptions = {},
): string[] {
  const storedTranslated = new Set<string>();
  for (const w of stored) {
    const parsed = parseStackTitleTranslatedWarning(w);
    if (parsed) storedTranslated.add(parsed.to);
  }

  const out: string[] = [];
  const push = (w: string | null) => {
    if (w && !out.includes(w)) out.push(w);
  };

  for (const w of stored) {
    if (parseStackTitleTranslatedWarning(w)) continue; // recalculado abaixo
    if (w.startsWith(STACK_TITLE_TRANSLATION_FAILED_PREFIX)) {
      if (stackTitleTranslationCandidates(sel).length > 0) push(w);
      continue;
    }
    if (w.startsWith(CIRCLE_STACK_MISSING_EDITIONS_PREFIX)) {
      const dates = w.slice(CIRCLE_STACK_MISSING_EDITIONS_PREFIX.length).split(/\s*,\s*/).filter(Boolean);
      const exists = opts.editionDirExists;
      push(circleStackMissingEditionsWarning(exists ? dates.filter((d) => exists(d)) : dates));
      continue;
    }
    if (WEAK_DESTAQUES_RE.test(w)) {
      const scores = sel.destaques.map((d) => (d as CircleStackItem & { score?: unknown }).score);
      if (scores.every((s) => typeof s === "number")) push(circleStackWeakDestaquesWarning(scores.filter((s) => s === 0).length));
      else push(w);
      continue;
    }
    push(w);
  }

  const seenUrls = new Set<string>();
  for (const section of SECTIONS) {
    for (const it of sel[section]) {
      if (seenUrls.has(it.url) || it.titleReviewed === true) continue;
      const translated = typeof it.titleTranslated === "string" ? it.title === it.titleTranslated : storedTranslated.has(it.title);
      if (!translated) continue;
      seenUrls.add(it.url);
      push(stackTitleTranslatedWarning(it.title, it.titleOriginal ?? it.title));
    }
  }
  return out;
}
