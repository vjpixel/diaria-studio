/**
 * inbox-stats.ts (#592, #609)
 *
 * Conta submissões do editor no archive da edição. Usado pela linha de
 * cobertura do `01-categorized.md` e do `02-reviewed.md`:
 *
 *   "Para esta edição, eu (o editor) enviei {X} submissões e a Diar.ia
 *    encontrou outros {Y} artigos. Selecionamos os {Z} mais relevantes
 *    para as pessoas que assinam a newsletter."
 *
 * #609: usa "submissões" (não "artigos enviados") — cada bloco de inbox
 * conta como 1 submissão, independente de quantas URLs venham dentro
 * (forwards de newsletter podem ter dezenas de URLs mas representam 1
 * ação editorial de envio).
 */

import { existsSync, readFileSync } from "node:fs";

const DEFAULT_EDITOR_EMAIL = "vjpixel@gmail.com";

/**
 * Conta TODOS os blocos no archive como submissões do editor (#1486).
 *
 * Antes (#592), filtrava por `from:` === editorEmail, mas forwards de
 * newsletters (7min.ai, AlphaSignal, etc.) chegam com `from:` do sender
 * original — o editor apenas fez forward. Todos os blocos existem porque
 * o editor os enviou, então contamos todos.
 *
 * `_editorEmail` mantido para backwards compat mas não é mais usado.
 *
 * Retorna 0 se arquivo ausente, malformado, ou vazio.
 */
export function countEditorSubmissions(
  inboxArchivePath: string,
  _editorEmail?: string,
): number {
  if (!existsSync(inboxArchivePath)) return 0;
  let text: string;
  try {
    text = readFileSync(inboxArchivePath, "utf8");
  } catch {
    return 0;
  }
  const blocks = text.split(/^## /m).slice(1);
  return blocks.length;
}

// (resolveInboxArchivePath removida em #1008 — dead code, knip findings)

/**
 * Lê o email do editor (linha "from") de platform.config.json se houver
 * configuração, senão retorna o default `vjpixel@gmail.com`.
 *
 * Lê `inbox.editor_personal_email` (campo novo) — distinto de
 * `inbox.address` (que é o destino diariaeditor@gmail.com, não o sender).
 */
export function resolveEditorEmail(platformConfigPath: string): string {
  if (!existsSync(platformConfigPath)) return DEFAULT_EDITOR_EMAIL;
  try {
    const cfg = JSON.parse(readFileSync(platformConfigPath, "utf8")) as {
      inbox?: { editor_personal_email?: string };
    };
    return cfg.inbox?.editor_personal_email ?? DEFAULT_EDITOR_EMAIL;
  } catch {
    return DEFAULT_EDITOR_EMAIL;
  }
}

/**
 * Formata a linha de cobertura no formato canônico (#592 + #609).
 *
 * #701: pluralização condicional pra concordância numérica em PT-BR — antes
 * "1 submissões"/"1 artigos" caía no leitor. Caller é livre pra passar
 * `selected = 0` (caso degenerado), mas a frase fica esquisita.
 *
 * Regex em `lint-newsletter-md.ts COVERAGE_LINE_RE` aceita ambas as formas
 * (singular e plural).
 */
export function formatCoverageLine(args: {
  editorSubmissions: number;
  diariaDiscovered: number;
  selected: number;
}): string {
  const subWord = args.editorSubmissions === 1 ? "submissão" : "submissões";
  const artWord = args.diariaDiscovered === 1 ? "artigo" : "artigos";
  const selPhrase =
    args.selected === 1
      ? "Selecionamos o artigo mais relevante"
      : `Selecionamos os ${args.selected} mais relevantes`;
  return (
    `Para esta edição, eu (o editor) enviei ${args.editorSubmissions} ${subWord} e a ` +
    `Diar.ia encontrou outros ${args.diariaDiscovered} ${artWord}. ${selPhrase} ` +
    `para as pessoas que assinam a newsletter.`
  );
}
