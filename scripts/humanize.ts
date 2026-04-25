/**
 * humanize.ts (#45)
 *
 * Pass determinístico de humanização ANTES da Clarice. Remove tics típicos
 * de AI-generated writing que a Clarice não cobre (ela foca em ortografia
 * e concordância). Conservador por design: só substitui/remove padrões com
 * substituição segura; sinaliza (sem alterar) padrões ambíguos pra revisão
 * manual no gate.
 *
 * Categorias:
 *   - REMOVALS — frases-muleta que tipicamente abrem uma sentença sem
 *     adicionar informação ("É importante notar que", "Vale destacar que").
 *     A frase fica mais direta sem elas.
 *   - SUBSTITUTIONS — pares onde a versão "humanizada" é claramente
 *     equivalente em significado mas mais natural.
 *   - FLAGS — padrões que merecem revisão (paralelismo "não apenas X, mas
 *     também Y", sentenças > 30 palavras, conectivos repetidos numa janela).
 *     Reportados, não alterados.
 *
 * Uso:
 *   npx tsx scripts/humanize.ts --in <md-path> --out <md-path>
 *
 * Output JSON em stderr com `{ removals_count, substitutions_count, flags[] }`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface HumanizeReport {
  removals_count: number;
  substitutions_count: number;
  flags: HumanizeFlag[];
}

export interface HumanizeFlag {
  rule: string;
  message: string;
  sample: string;
}

interface RemovalRule {
  pattern: RegExp;
  description: string;
}

// Sem `\b` no início — JS regex não reconhece word boundary antes de chars
// acentuados (é, ç). Usamos a checagem `isStart` no callback pra filtrar
// matches válidos (início de sentença / após pontuação forte).
const REMOVALS: RemovalRule[] = [
  { pattern: /é importante notar que\s+/gi, description: "muleta-import" },
  { pattern: /vale (a pena )?notar que\s+/gi, description: "muleta-notar" },
  { pattern: /vale (a pena )?destacar que\s+/gi, description: "muleta-destacar" },
  { pattern: /vale (a pena )?ressaltar que\s+/gi, description: "muleta-ressaltar" },
  { pattern: /vale (a pena )?mencionar que\s+/gi, description: "muleta-mencionar" },
  { pattern: /cabe destacar que\s+/gi, description: "muleta-cabe-destacar" },
  { pattern: /cabe ressaltar que\s+/gi, description: "muleta-cabe-ressaltar" },
  { pattern: /cabe notar que\s+/gi, description: "muleta-cabe-notar" },
  { pattern: /é interessante notar que\s+/gi, description: "muleta-interessante" },
];

interface SubstitutionRule {
  pattern: RegExp;
  replacement: string;
  description: string;
}

const SUBSTITUTIONS: SubstitutionRule[] = [
  // Conectivos pomposos → versão direta
  { pattern: /\bno entanto, é\b/gi, replacement: "mas é", description: "no-entanto-é" },
  { pattern: /\bdesta forma,\s+/gi, replacement: "Assim, ", description: "desta-forma" },
  { pattern: /\bdessa forma,\s+/gi, replacement: "Assim, ", description: "dessa-forma" },
  // Phrasings corporativas frequentes em LLM output
  { pattern: /\bem última análise\b/gi, replacement: "no fim", description: "ultima-analise" },
  { pattern: /\bno final das contas\b/gi, replacement: "no fim", description: "final-das-contas" },
];

const REPETITIVE_CONNECTIVES = [
  "além disso",
  "por outro lado",
  "em resumo",
  "em suma",
  "por fim",
  "dessa maneira",
];

/**
 * Recapitaliza primeira letra de sentenças após pontuação forte / início de
 * linha. Mantém o resto do texto.
 */
function recapitalizeSentenceStarts(text: string): string {
  return text.replace(
    /(^|[\n.!?]\s+)([a-zà-ÿ])/g,
    (_, prefix: string, ch: string) => prefix + ch.toUpperCase(),
  );
}

/**
 * Remove frases-muleta de início de sentença. Só remove quando a muleta vem
 * ao início do parágrafo OU logo após pontuação forte (`.`, `!`, `?`).
 * Recapitalização é responsabilidade do pipeline (humanize).
 */
export function applyRemovals(
  text: string,
): { text: string; count: number } {
  let count = 0;
  let result = text;

  for (const rule of REMOVALS) {
    const replaced = result.replace(rule.pattern, (match, ..._args) => {
      // Em regex com 1 grupo de captura, args é [capture, offset, str].
      const offset = _args[_args.length - 2] as number;
      const before = result.slice(Math.max(0, offset - 3), offset);
      const isStart = offset === 0 || /[\n.!?]\s*$/.test(before);
      if (!isStart) return match;
      count++;
      return "";
    });
    result = replaced;
  }

  // Limpar espaços duplos resultantes da remoção
  result = result.replace(/  +/g, " ");

  return { text: result, count };
}

export function applySubstitutions(
  text: string,
): { text: string; count: number } {
  let count = 0;
  let result = text;
  for (const rule of SUBSTITUTIONS) {
    result = result.replace(rule.pattern, () => {
      count++;
      return rule.replacement;
    });
  }
  return { text: result, count };
}

/**
 * Sentenças > 30 palavras viram flag (não auto-encurtar — mudança semântica).
 */
export function flagLongSentences(text: string): HumanizeFlag[] {
  const flags: HumanizeFlag[] = [];
  // Split por . ! ? mantendo o delimitador
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);
  for (const s of sentences) {
    const words = s.trim().split(/\s+/).filter(Boolean);
    if (words.length > 30) {
      flags.push({
        rule: "long_sentence",
        message: `Sentença com ${words.length} palavras (> 30) — considerar dividir`,
        sample: s.slice(0, 100) + (s.length > 100 ? "..." : ""),
      });
    }
  }
  return flags;
}

/**
 * Paralelismo "não apenas X, mas também Y" → flag (substituição depende
 * do contexto editorial; auto-substituir muda voz).
 */
export function flagMechanicalParallelism(text: string): HumanizeFlag[] {
  const flags: HumanizeFlag[] = [];
  const matches = [...text.matchAll(/não apenas[^.!?\n]{1,80}mas também/gi)];
  for (const m of matches) {
    flags.push({
      rule: "mechanical_parallelism",
      message: '"não apenas X, mas também Y" — considerar reescrever',
      sample: m[0].slice(0, 100),
    });
  }
  return flags;
}

/**
 * Conectivos repetidos numa janela curta sinalizam que o LLM ficou em loop.
 * Reporta se o mesmo conectivo aparece 2+ vezes em 500 chars.
 */
export function flagRepetitiveConnectives(text: string): HumanizeFlag[] {
  const flags: HumanizeFlag[] = [];
  for (const conn of REPETITIVE_CONNECTIVES) {
    const re = new RegExp(`\\b${conn}\\b`, "gi");
    const positions = [...text.matchAll(re)].map((m) => m.index ?? 0);
    if (positions.length < 2) continue;
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] - positions[i - 1] < 500) {
        flags.push({
          rule: "repetitive_connective",
          message: `Conectivo "${conn}" repetido em janela curta (${positions[i] - positions[i - 1]} chars)`,
          sample: text.slice(Math.max(0, positions[i - 1]), positions[i] + conn.length + 20),
        });
        break;
      }
    }
  }
  return flags;
}

export function humanize(text: string): { text: string; report: HumanizeReport } {
  const removalsResult = applyRemovals(text);
  const substitutionsResult = applySubstitutions(removalsResult.text);
  // Recapitalização única no fim — cobre o que sobrou após removals e o
  // resultado de substitutions com replacement minúsculo.
  const finalText = recapitalizeSentenceStarts(substitutionsResult.text);
  const flags = [
    ...flagLongSentences(finalText),
    ...flagMechanicalParallelism(finalText),
    ...flagRepetitiveConnectives(finalText),
  ];
  return {
    text: finalText,
    report: {
      removals_count: removalsResult.count,
      substitutions_count: substitutionsResult.count,
      flags,
    },
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error("Uso: humanize.ts --in <md-path> --out <md-path>");
    process.exit(1);
  }
  const inPath = resolve(ROOT, args.in);
  const outPath = resolve(ROOT, args.out);
  const text = readFileSync(inPath, "utf8");
  const result = humanize(text);
  writeFileSync(outPath, result.text, "utf8");
  console.error(JSON.stringify(result.report, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
