#!/usr/bin/env npx tsx
/**
 * lint-annual-draft.ts (#7569) — Etapa 2b/4c da `/diaria-anual`.
 *
 * Duas camadas, como no lint do mensal (#423 + guardrail #2794):
 *
 *   - **Advisory (exit 0):** tetos de caracteres por bloco. Passar do teto é
 *     um aviso que vai pro resumo do gate, não um bloqueio.
 *   - **Crítico (exit 1):** o que faria a edição sair QUEBRADA. Simula o
 *     render final com imagens fictícias e reprova se um label não foi
 *     reconhecido, se algum tema sairia sem imagem, se o N de temas está
 *     fora de 3–7, se uma seção proibida (Use Melhor, Radar, "É IA?")
 *     apareceu, ou se o bloco de aniversário está no lugar errado para o
 *     tipo de rodada.
 *
 * A carta do editor em placeholder é caso à parte: **não bloqueia aqui**
 * (o writer sempre a deixa assim, e o lint roda logo depois dele na Etapa 2),
 * mas sai como `editor_letter_pending: true` no relatório, e é o gate da
 * Etapa 4 que cobra. Bloquear na Etapa 2 impediria o pipeline de chegar até o
 * gate onde o editor de fato escreve a carta.
 *
 * Uso:
 *   npx tsx scripts/lint-annual-draft.ts --slug 2026-aniversario
 *   npx tsx scripts/lint-annual-draft.ts --draft caminho/draft.md --tipo aniversario
 *
 * Exit codes: 0 íntegro · 1 falha crítica · 2 draft não encontrado.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { annualPaths } from "./lib/anual/annual-paths.ts";
import { parseAnnualDraft, themeCharCount, FORBIDDEN_LABELS, type AnnualDraft } from "./lib/anual/annual-parse.ts";
import { renderAnnualEmail } from "./lib/anual/annual-render.ts";
import { tipoFromSlug, type AnnualTipo } from "./lib/anual/annual-window.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Tetos por bloco — advisory. Ver `context/templates/newsletter-anual.md`. */
export const LIMITS = {
  theme: 2000,
  whatChanged: 1800,
  predictions: 2000,
  anniversary: 1500,
} as const;

export const MIN_THEMES = 3;
export const MAX_THEMES = 7;

export interface LintAnnualResult {
  ok: boolean;
  themes: number;
  errors: string[];
  warnings: string[];
  editor_letter_pending: boolean;
  render: { imageCount: number; missingImages: number[] };
}

export function lintAnnualDraft(md: string, tipo: AnnualTipo): LintAnnualResult {
  const draft: AnnualDraft = parseAnnualDraft(md);
  const errors: string[] = [];
  const warnings: string[] = [...draft.warnings];

  // ── Crítico: labels reconhecidos ────────────────────────────────────
  for (const w of draft.warnings) {
    if (w.startsWith("label não reconhecido")) {
      errors.push(
        `${w} — o render não sabe onde essa seção começa; confira o negrito do label ou remova a seção.`,
      );
    }
  }

  // ── Crítico: seções que a anual não tem ─────────────────────────────
  for (const label of draft.labels) {
    const upper = label.toUpperCase();
    if (FORBIDDEN_LABELS.some((f) => upper.startsWith(f))) {
      errors.push(`seção "${label}" não existe na edição anual (decisão do editor, 07/09/2026)`);
    }
  }

  // ── Crítico: N de temas ─────────────────────────────────────────────
  if (draft.themes.length < MIN_THEMES || draft.themes.length > MAX_THEMES) {
    errors.push(
      `${draft.themes.length} tema(s) — a anual tem entre ${MIN_THEMES} e ${MAX_THEMES}. ` +
        `Se o material do período não sustenta ${MIN_THEMES}, o problema é a coleta, não o texto.`,
    );
  }
  const expected = draft.themes.map((_, i) => i + 1);
  const got = draft.themes.map((t) => t.index);
  if (JSON.stringify(expected) !== JSON.stringify(got)) {
    errors.push(`numeração dos temas fora de sequência: ${got.join(",")} (esperado ${expected.join(",")})`);
  }

  // ── Crítico: bloco de aniversário no lugar certo ────────────────────
  if (tipo === "aniversario" && !draft.anniversary) {
    errors.push("rodada de aniversário sem bloco ANIVERSÁRIO");
  }
  if (tipo === "janeiro" && draft.anniversary) {
    errors.push("rodada de janeiro não leva bloco ANIVERSÁRIO — remova a seção");
  }
  // A carta do editor vive DENTRO do bloco de aniversário. Numa rodada de
  // janeiro o render simplesmente a ignora — o texto sumiria do e-mail sem
  // erro nem aviso. Mesmo guard simétrico que o bloco acima já tem.
  if (tipo === "janeiro" && draft.editorLetter) {
    errors.push("rodada de janeiro não leva CARTA DO EDITOR — o render descartaria a seção em silêncio");
  }

  // ── Crítico: sonda de render ────────────────────────────────────────
  // Imagens fictícias: na Etapa 2 as reais ainda não existem, e o que se está
  // testando é se o RENDER as colocaria, não se elas já foram geradas.
  const probeImages = Object.fromEntries(draft.themes.map((t) => [t.index, `https://exemplo.invalid/${t.index}.jpg`]));
  const render = renderAnnualEmail(draft, {
    windowLabel: "sonda",
    tipo,
    images: probeImages,
  });
  if (draft.themes.length > 0 && render.imageCount < draft.themes.length) {
    errors.push(
      `sonda de render: ${render.imageCount} <img> para ${draft.themes.length} temas — ` +
        `a edição sairia com tema sem imagem.`,
    );
  }
  warnings.push(...render.warnings);

  // ── Advisory: tetos de caracteres ───────────────────────────────────
  for (const theme of draft.themes) {
    const n = themeCharCount(theme);
    if (n > LIMITS.theme) warnings.push(`TEMA ${theme.index}: ${n} chars (teto ${LIMITS.theme})`);
    if (theme.paragraphs.length === 0) warnings.push(`TEMA ${theme.index}: sem parágrafo de corpo`);
  }
  if (draft.whatChanged.length > LIMITS.whatChanged) {
    warnings.push(`O QUE MUDOU: ${draft.whatChanged.length} chars (teto ${LIMITS.whatChanged})`);
  }
  if (draft.predictions.length > LIMITS.predictions) {
    warnings.push(`PREVISÕES: ${draft.predictions.length} chars (teto ${LIMITS.predictions})`);
  }
  if (draft.anniversary && draft.anniversary.length > LIMITS.anniversary) {
    warnings.push(`ANIVERSÁRIO: ${draft.anniversary.length} chars (teto ${LIMITS.anniversary})`);
  }

  // ── Advisory: blocos vazios que o template pede ─────────────────────
  if (!draft.whatChanged) warnings.push('seção "O QUE MUDOU" ausente ou vazia');
  if (!draft.predictions) warnings.push('seção "PREVISÕES" ausente ou vazia');
  if (draft.subjects.length < 3) warnings.push(`ASSUNTO com ${draft.subjects.length} opção(ões) — o template pede 3`);

  return {
    ok: errors.length === 0,
    themes: draft.themes.length,
    errors,
    warnings,
    editor_letter_pending: tipo === "aniversario" && (draft.editorLetter?.placeholder ?? true),
    render: { imageCount: render.imageCount, missingImages: render.missingImages },
  };
}

function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseCliArgs(argv);
  const log = (m: string) => process.stderr.write(`[lint-annual-draft] ${m}\n`);

  let draftPath: string;
  let tipo: AnnualTipo;

  if (args.values.slug) {
    const slug = args.values.slug;
    draftPath = annualPaths(slug, resolve(ROOT, "data/annual")).draft;
    tipo = tipoFromSlug(slug);
  } else if (args.values.draft) {
    draftPath = resolve(args.values.draft);
    tipo = (args.values.tipo as AnnualTipo) ?? "janeiro";
  } else {
    log("uso: --slug 2026-aniversario | --draft <caminho> [--tipo aniversario|janeiro]");
    process.exitCode = 2;
    return;
  }

  if (!existsSync(draftPath)) {
    log(`draft não encontrado: ${draftPath}`);
    process.exitCode = 2;
    return;
  }

  const result = lintAnnualDraft(readFileSync(draftPath, "utf8"), tipo);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  for (const w of result.warnings) log(`aviso: ${w}`);
  for (const e of result.errors) log(`ERRO: ${e}`);
  if (result.editor_letter_pending) log("carta do editor ainda é placeholder — o gate da Etapa 4 vai cobrar.");
  if (!result.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main();

