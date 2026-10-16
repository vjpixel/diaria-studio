/**
 * estilo-false-positives.ts (#10328)
 *
 * Marcação de falso positivo do achado de Noite Estrelada (`categoria:
 * "estilo"`, #8989/#10312) do `image-crop-reviewer`, guardada FORA do arquivo
 * de veredito.
 *
 * Antes, a saída documentada para falso positivo era trocar a entrada para
 * `status: "ok"` em `_internal/04-crop-review.json`. Só que o persist do
 * revisor (`run-image-crop-reviewer.ts --input-json`) reescreve esse arquivo
 * inteiro, e o §4d.1 do Stage 4 manda repetir a revisão com TODOS os pares
 * depois de qualquer regeneração. Trocar a imagem do D3 apagava a marcação do
 * D1, o revisor reavaliava o D1 com o mesmo veredito e o erro voltava (em
 * `--no-gates`, a rodada parava de novo).
 *
 * A marcação é chaveada pelo md5 da imagem julgada (o mesmo `image_md5` que o
 * persist carimba, #9598/#10325): vale enquanto a imagem for a mesma, viaja
 * sozinha num reorder (o conteúdo também viaja) e caduca sozinha quando a
 * imagem é regerada — imagem nova merece veredito novo.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export const ESTILO_FALSE_POSITIVES_FILE = "04-estilo-false-positives.json";

export interface EstiloFalsePositiveEntry {
  image_md5: string;
  /** Informativos: posição/formato no momento da marcação (a chave é o md5). */
  destaque?: string;
  ratio?: string;
  marked_at: string;
}

interface EstiloFalsePositivesFile {
  entries: EstiloFalsePositiveEntry[];
}

const MD5_RE = /^[0-9a-f]{32}$/;

export function estiloFalsePositivesPath(editionDir: string): string {
  return resolve(editionDir, "_internal", ESTILO_FALSE_POSITIVES_FILE);
}

function readFile(editionDir: string): EstiloFalsePositivesFile {
  const path = estiloFalsePositivesPath(editionDir);
  if (!existsSync(path)) return { entries: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
    const entries = Array.isArray(data.entries)
      ? data.entries.filter(
          (e): e is EstiloFalsePositiveEntry =>
            !!e && typeof e === "object" && typeof (e as { image_md5?: unknown }).image_md5 === "string" &&
            MD5_RE.test((e as { image_md5: string }).image_md5),
        )
      : [];
    return { entries };
  } catch {
    // Ilegível: sem marcação nenhuma. Falha para o lado seguro (o erro de
    // Noite Estrelada aparece), nunca para o lado que publicaria a imagem.
    return { entries: [] };
  }
}

/** md5s das imagens marcadas como falso positivo de Noite Estrelada. */
export function readEstiloFalsePositiveMd5s(editionDir: string): Set<string> {
  return new Set(readFile(editionDir).entries.map((e) => e.image_md5));
}

/** Entrada de veredito de estilo cuja imagem o editor marcou como falso positivo. */
export function isEstiloFalsePositive(
  entry: { categoria?: string; image_md5?: string },
  falsePositives: Set<string>,
): boolean {
  return entry.categoria === "estilo" && typeof entry.image_md5 === "string" && falsePositives.has(entry.image_md5);
}

/**
 * Acrescenta marcações (idempotente por md5). Devolve quantas eram novas.
 * md5 inválido é ignorado.
 */
export function addEstiloFalsePositives(
  editionDir: string,
  marks: Array<{ image_md5: string; destaque?: string; ratio?: string }>,
  now: Date = new Date(),
): number {
  const file = readFile(editionDir);
  const known = new Set(file.entries.map((e) => e.image_md5));
  let added = 0;
  for (const m of marks) {
    if (!MD5_RE.test(m.image_md5) || known.has(m.image_md5)) continue;
    known.add(m.image_md5);
    file.entries.push({
      image_md5: m.image_md5,
      ...(m.destaque ? { destaque: m.destaque } : {}),
      ...(m.ratio ? { ratio: m.ratio } : {}),
      marked_at: now.toISOString(),
    });
    added++;
  }
  if (added > 0) {
    const path = estiloFalsePositivesPath(editionDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2), "utf8");
  }
  return added;
}
