/**
 * scripts/lib/calibration-file-allowlist.ts (#7978, Camada 5 da #7972)
 *
 * A LISTA canônica de "o que conta como mudança de calibração de verdade"
 * — o portão de promoção/sign-off (#7978) só faz sentido se souber
 * exatamente quando se aplicar. Puro, sem I/O (recebe conteúdo de arquivo
 * já lido pelo chamador — `scripts/check-editorial-signoff.ts` é quem lê
 * disco/git diff).
 *
 * Dois tipos de arquivo calibrável, tratados de forma diferente:
 *
 * 1. **Arquivos TS de bônus** (`scripts/lib/coverage-bonus.ts`,
 *    `scripts/lib/audience-affinity.ts`) e `context/scoring/rubric.json` —
 *    QUALQUER mudança de conteúdo conta. São arquivos pequenos e
 *    dedicados, sem "ruído" de conteúdo não-calibrável misturado.
 *
 * 2. **Corpo de agent prompt** (`.claude/agents/scorer.md`,
 *    `.claude/agents/scorer-chunk.md`) — só conta se a mudança tocar
 *    DENTRO de um bloco `<!-- CALIBRATED:{feature}:start -->` /
 *    `<!-- CALIBRATED:{feature}:end -->`. Esses arquivos são prompts
 *    inteiros com centenas de linhas de instrução editorial — exigir
 *    sign-off em QUALQUER edição (corrigir typo, reescrever uma frase de
 *    contexto) tornaria o portão inútil por fricção (toda mudança de
 *    prosa vira burocracia de sign-off) e treinaria o editor a aprovar
 *    sem ler. Os marcadores CALIBRATED existem exatamente pra isolar os
 *    trechos que de fato mudam pontuação/seleção/prompt de geração REAL.
 */

export interface CalibrationTsFileEntry {
  kind: "ts-file";
  path: string;
}

export interface CalibrationMarkedFileEntry {
  kind: "marked-blocks";
  path: string;
}

export type CalibrationAllowlistEntry = CalibrationTsFileEntry | CalibrationMarkedFileEntry;

/** Fonte única da allowlist — adicionar aqui pra um novo arquivo calibrável passar a exigir sign-off. */
export const CALIBRATION_ALLOWLIST: readonly CalibrationAllowlistEntry[] = [
  { kind: "ts-file", path: "scripts/lib/coverage-bonus.ts" },
  { kind: "ts-file", path: "scripts/lib/audience-affinity.ts" },
  { kind: "ts-file", path: "context/scoring/rubric.json" },
  { kind: "marked-blocks", path: ".claude/agents/scorer.md" },
  { kind: "marked-blocks", path: ".claude/agents/scorer-chunk.md" },
];

const MARKER_START = /<!--\s*CALIBRATED:([a-zA-Z0-9_]+):start\s*-->/;
const MARKER_END = /<!--\s*CALIBRATED:([a-zA-Z0-9_]+):end\s*-->/;

export interface CalibratedBlock {
  feature: string;
  /** Linhas 1-indexed, inclusivas — a linha do marcador start até a do marcador end (marcadores incluídos, porque um diff que só toca o marcador em si também é uma mudança estrutural do bloco calibrável). */
  startLine: number;
  endLine: number;
}

/**
 * Extrai os blocos `CALIBRATED:{feature}:start/end` de um arquivo de agent
 * prompt já lido. Marcador start sem end correspondente (ou vice-versa,
 * ou feature-name divergente entre os dois) é um erro de AUTORIA do
 * arquivo — lançado alto em vez de ignorado silenciosamente, porque um
 * bloco malformado deixaria uma mudança de calibração passar despercebida
 * pelo gate (justamente o cenário que este mecanismo existe pra prevenir).
 */
export function extractCalibratedBlocks(content: string): CalibratedBlock[] {
  const lines = content.split("\n");
  const blocks: CalibratedBlock[] = [];
  let openFeature: string | null = null;
  let openLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const startMatch = MARKER_START.exec(lines[i]);
    const endMatch = MARKER_END.exec(lines[i]);

    if (startMatch) {
      if (openFeature !== null) {
        throw new Error(`Bloco CALIBRATED:${openFeature} aberto na linha ${openLine} nunca foi fechado antes de outro start (CALIBRATED:${startMatch[1]}) na linha ${lineNo} — marcadores não podem aninhar.`);
      }
      openFeature = startMatch[1];
      openLine = lineNo;
    }
    if (endMatch) {
      if (openFeature === null) {
        throw new Error(`CALIBRATED:${endMatch[1]}:end na linha ${lineNo} sem start correspondente.`);
      }
      if (endMatch[1] !== openFeature) {
        throw new Error(`CALIBRATED:${openFeature}:start (linha ${openLine}) fechado por CALIBRATED:${endMatch[1]}:end (linha ${lineNo}) — nomes de feature divergentes.`);
      }
      blocks.push({ feature: openFeature, startLine: openLine, endLine: lineNo });
      openFeature = null;
      openLine = -1;
    }
  }

  if (openFeature !== null) {
    throw new Error(`Bloco CALIBRATED:${openFeature} aberto na linha ${openLine} nunca foi fechado.`);
  }

  return blocks;
}

/**
 * Dado o path de um arquivo mudado e o conjunto de números de linha que o
 * diff efetivamente tocou (added/removed, 1-indexed no arquivo NOVO —
 * `scripts/check-editorial-signoff.ts` é quem faz esse parsing de diff),
 * decide se essa mudança conta como calibração de verdade.
 *
 * Para `ts-file`/`rubric.json`: sempre `true` se o path está na allowlist
 * e tem pelo menos 1 linha tocada. Para `marked-blocks`: `true` se alguma
 * linha tocada cai DENTRO de algum bloco CALIBRATED do arquivo NOVO, OU se
 * algum bloco que existia no arquivo ANTIGO (`oldContent`) sumiu no novo —
 * achado de review do #7978 (alta confiança): sem essa 2ª checagem, um
 * PR que APAGA os marcadores `CALIBRATED:*` e muda o valor de bônus na
 * MESMA diff escapava do gate por completo — `extractCalibratedBlocks`
 * no conteúdo novo simplesmente não encontrava bloco nenhum pra comparar
 * contra as linhas tocadas, então `touchesCalibration` dava `false` pro
 * exato cenário que o gate existe pra impedir.
 */
export function isCalibrationTouchingFile(path: string, touchedLines: ReadonlySet<number>, newContent: string | null, oldContent: string | null = null): boolean {
  const entry = CALIBRATION_ALLOWLIST.find((e) => e.path === path);
  if (!entry) return false;

  // marked-blocks: arquivo deletado (newContent null) conta como calibração
  // — perder o rubrico inteiro é claramente uma mudança real, nunca passa
  // batido por "não achei bloco nenhum pra comparar". CHECADO ANTES do
  // early-return de `touchedLines.size === 0` de propósito (achado de
  // review do #7978, alta confiança): uma deleção PURA de arquivo produz
  // um hunk `+c,0` no diff, que `parseTouchedLinesFromUnifiedZeroDiff`
  // deliberadamente NÃO marca nenhuma linha nova (não há linha nova a
  // marcar) — então `touchedLines` chega aqui VAZIO justo no caso que esta
  // branch existe pra cobrir. A ordem anterior deixava esse branch morto:
  // o early-return de linhas vazias sempre disparava primeiro.
  if (newContent === null) return true;

  if (entry.kind === "marked-blocks" && oldContent !== null) {
    const oldFeatures = new Set(extractCalibratedBlocks(oldContent).map((b) => b.feature));
    const newFeatures = new Set(extractCalibratedBlocks(newContent).map((b) => b.feature));
    for (const f of oldFeatures) {
      if (!newFeatures.has(f)) return true; // marcador que existia sumiu — bloco removido, não passa em silêncio
    }
  }

  if (touchedLines.size === 0) return false;

  if (entry.kind === "ts-file") return true;

  const blocks = extractCalibratedBlocks(newContent);
  for (const line of touchedLines) {
    if (blocks.some((b) => line >= b.startLine && line <= b.endLine)) return true;
  }
  return false;
}
