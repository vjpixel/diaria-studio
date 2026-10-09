/**
 * past-editions-voice.ts (#9978)
 *
 * Desde o #9955 `data/past-editions.md` cobre ~30 dias (dedupEditionCount=35,
 * ~2750 linhas / ~55-60k tokens) — é a fonte do dedup de URL em janela de 30
 * dias (`dedup.ts`, `finalize-stage1.ts`, `check-promoted-dedup.ts`,
 * invariante do Stage 4) e precisa continuar INTEIRA.
 *
 * Os agentes LLM, porém, só leem o arquivo pra calibrar voz/abertura das
 * edições mais recentes (writer, writer-destaque, research-reviewer,
 * humanizador). Ler o arquivo de 30 dias estoura o `Read` (25k tokens / 2000
 * linhas) e triplica o custo de tokens dos 3 writers paralelos.
 *
 * Solução: um 2º arquivo derivado, `data/past-editions-recent.md`, com só as
 * `VOICE_EDITION_COUNT` seções mais recentes. Os prompts leem este; os scripts de dedup seguem lendo o
 * arquivo completo. Regenerado por todo escritor de `past-editions.md`
 * (`refresh-dedup.ts`, `refresh-past-editions.ts`, `merge-local-pending.ts`).
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Seções que os agentes leem pra voz. Antes do #9955 o arquivo tinha 14 e já
 * encostava no teto do Read (medido em 261009: 1100 linhas / 93k chars ≈ 24k
 * de 25k tokens) — 12 deixa ~15% de folga pra semana de edições mais longas
 * e ainda cobre com sobra os 7 dias do Filtro 2 do research-reviewer.
 */
export const VOICE_EDITION_COUNT = 12;

/** Nome do arquivo derivado, sempre irmão de `past-editions.md`. */
export const VOICE_FILE_NAME = "past-editions-recent.md";

const SECTION_RE = /^## (\d{4}-\d{2}-\d{2})\b/;

export function voicePathFor(mdPath: string): string {
  return join(dirname(mdPath), VOICE_FILE_NAME);
}

/**
 * Recorta as `count` seções `## YYYY-MM-DD` mais recentes (por data do
 * cabeçalho, não por posição — `merge-local-pending.ts` appenda seções
 * pending no FIM do arquivo, que são justamente as mais novas).
 * Empate de data preserva a ordem original.
 */
export function buildVoiceExcerpt(md: string, count: number = VOICE_EDITION_COUNT): string {
  const lines = md.split("\n");
  const sections: Array<{ date: string; idx: number; lines: string[] }> = [];
  let current: { date: string; idx: number; lines: string[] } | null = null;
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m) {
      current = { date: m[1], idx: sections.length, lines: [line] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }

  const picked = [...sections]
    .sort((a, b) => (a.date === b.date ? a.idx - b.idx : a.date < b.date ? 1 : -1))
    .slice(0, count);

  const out: string[] = [
    "# Edições recentes — referência de voz/abertura",
    "",
    `**edições neste recorte:** ${picked.length} (de ${sections.length} em past-editions.md)`,
    "",
    "Recorte das edições mais recentes de `data/past-editions.md` (#9978), para os",
    "agentes calibrarem voz e evitarem repetir aberturas. NÃO é a fonte do dedup de",
    "URL — o bloqueio de links repetidos em ~30 dias roda nos scripts contra o",
    "arquivo completo.",
    "",
    "---",
    "",
  ];
  for (const s of picked) {
    // Garante separador entre seções mesmo que a última do arquivo não tenha `---`.
    const body = [...s.lines];
    while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
    if (body[body.length - 1]?.trim() !== "---") body.push("", "---");
    out.push(...body, "");
  }
  return out.join("\n");
}

/**
 * Regenera o recorte de voz a partir de `mdPath` (atômico via tmp+rename).
 * Fail-soft: `mdPath` ausente → não escreve nada e devolve `null`.
 */
export function writeVoiceExcerpt(
  mdPath: string,
  outPath: string = voicePathFor(mdPath),
  count: number = VOICE_EDITION_COUNT,
): string | null {
  if (!existsSync(mdPath)) return null;
  const excerpt = buildVoiceExcerpt(readFileSync(mdPath, "utf8"), count);
  const tmp = outPath + ".tmp";
  writeFileSync(tmp, excerpt, "utf8");
  renameSync(tmp, outPath);
  return outPath;
}
