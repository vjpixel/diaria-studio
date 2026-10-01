/**
 * plant-intentional-error.ts (#9255)
 *
 * Plantio DETERMINÍSTICO do erro intencional no Stage 2. Decisão do editor
 * (briefing 261001, opção a): o Stage 2 headless SEMPRE propõe e planta o
 * erro (padrão #5742) — antes, o playbook mandava "perguntar ao editor", e
 * numa sessão headless sem ninguém pra responder o MD ficava com
 * `Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.` + JSON `{PREENCHER}`,
 * travando o sentinel do Stage 2 (edição 261001). O placeholder continua
 * gate-blocking — este módulo existe pra que ele não sobre.
 *
 * Puro: recebe o MD + o candidato (de `proposeIntentionalErrorCandidate`)
 * e devolve o MD com (1) a 1ª menção do `correct_value` na seção do
 * candidato trocada pelo `wrong_value` e (2) o placeholder da narrativa
 * substituído por uma declaração que não entrega a resposta.
 */

import type { IntentionalErrorCandidate } from "./propose-intentional-error-candidate.ts";

export const NARRATIVE_PLACEHOLDER = "{PREENCHER_NARRATIVA_DO_ERRO}";

const SECONDARY_HEADERS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "LANÇAMENTOS", re: /^\s*(?:\*\*)?(?:\S+\s+)?LAN[ÇC]AMENTOS?\s*(?:\*\*)?\s*$/iu },
  { name: "RADAR", re: /^\s*(?:\*\*)?(?:\S+\s+)?(?:RADAR|OUTRAS?\s+NOT[ÍI]CIAS?)\s*(?:\*\*)?\s*$/iu },
  { name: "USE MELHOR", re: /^\s*(?:\*\*)?(?:\S+\s+)?USE\s+MELHOR\s*(?:\*\*)?\s*$/iu },
  { name: "VÍDEOS", re: /^\s*(?:\*\*)?(?:\S+\s+)?V[ÍI]DEOS?\s*(?:\*\*)?\s*$/iu },
  { name: "É IA?", re: /^\s*(?:##\s+)?É\s+IA\?\s*$/iu },
];

const DESTAQUE_RE = /^\s*(?:\*\*)?DESTAQUE\s+\d/i;
/** Header genérico em negrito (`**ERRO INTENCIONAL**`, `**SORTEIO**`) — encerra a seção corrente. Linha de item (`**[título](url)**`) não conta. */
const GENERIC_BOLD_HEADER_RE = /^\s*\*\*[^*[\]]+\*\*\s*$/;

/** Extrai o nome da seção do `location` do candidato (`"RADAR (menção a ...)"`). */
export function sectionFromLocation(location: string): string | null {
  const hit = SECONDARY_HEADERS.find(({ name }) => location.startsWith(name));
  return hit ? hit.name : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Faixas proibidas da linha: o `(url)` de links markdown e URLs cruas. */
function forbiddenRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of line.matchAll(/\]\([^)]*\)/g)) ranges.push([m.index!, m.index! + m[0].length]);
  for (const m of line.matchAll(/https?:\/\/\S+/g)) ranges.push([m.index!, m.index! + m[0].length]);
  return ranges;
}

/** Faixas do texto-âncora `[...]` (permitido só como último recurso). */
function anchorRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of line.matchAll(/\[[^\]]*\]\(/g)) ranges.push([m.index!, m.index! + m[0].length]);
  return ranges;
}

const inside = (pos: number, ranges: Array<[number, number]>): boolean =>
  ranges.some(([a, b]) => pos >= a && pos < b);

/**
 * Troca a 1ª menção de `correct` por `wrong` dentro da seção `section`
 * (nunca em bloco DESTAQUE, nunca dentro de URL). Prefere texto corrido;
 * só cai no texto-âncora de link se não houver menção fora dele.
 * Retorna `null` se não achou menção plantável.
 */
export function plantWrongValue(md: string, section: string, correct: string, wrong: string): string | null {
  const lines = md.split("\n");
  const wordRe = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(correct)}(?![\\p{L}\\p{N}])`, "gu");

  for (const allowAnchor of [false, true]) {
    let current: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*---\s*$/.test(line) || DESTAQUE_RE.test(line)) {
        current = null;
        continue;
      }
      const header = SECONDARY_HEADERS.find(({ re }) => re.test(line));
      if (header) {
        current = header.name;
        continue;
      }
      if (GENERIC_BOLD_HEADER_RE.test(line)) {
        current = null;
        continue;
      }
      if (current !== section) continue;

      const forbidden = forbiddenRanges(line);
      const anchors = anchorRanges(line);
      for (const m of line.matchAll(wordRe)) {
        const pos = m.index!;
        if (inside(pos, forbidden)) continue;
        if (!allowAnchor && inside(pos, anchors)) continue;
        lines[i] = line.slice(0, pos) + wrong + line.slice(pos + correct.length);
        return lines.join("\n");
      }
    }
  }
  return null;
}

/** Declaração da edição corrente — dá a pista (seção + tipo) sem entregar a resposta. */
export function buildCurrentNarrative(section: string): string {
  // Frase ÚNICA terminada em "." — `extractRawCurrentNarrative` captura até o
  // 1º ponto, e um rerun do render-erro-intencional reconstrói a linha a partir dela.
  return `Nessa edição, o nome de uma marca de IA bem conhecida saiu grafado errado na seção ${section.replace(/\?$/, "")}.`;
}

export interface PlantResult {
  md: string;
  section: string;
}

/**
 * Planta o candidato no MD: troca o valor e preenche a narrativa.
 * Retorna `null` quando não dá pra plantar (seção desconhecida ou menção
 * ausente fora de URL) — o chamador NÃO grava nada nesse caso.
 */
export function plantIntentionalError(md: string, candidate: IntentionalErrorCandidate): PlantResult | null {
  const section = sectionFromLocation(candidate.location);
  if (!section) return null;
  const planted = plantWrongValue(md, section, candidate.correct_value, candidate.wrong_value);
  if (planted === null) return null;
  const narrativeLineRe = new RegExp(`^.*${escapeRegExp(NARRATIVE_PLACEHOLDER)}.*$`, "m");
  const withNarrative = narrativeLineRe.test(planted)
    ? planted.replace(narrativeLineRe, buildCurrentNarrative(section))
    : planted;
  return { md: withNarrative, section };
}
