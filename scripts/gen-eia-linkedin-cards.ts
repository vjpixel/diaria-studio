/**
 * gen-eia-linkedin-cards.ts
 *
 * Gera a arte do "É IA?" carimbada com A e B, pra publicação MANUAL no
 * LinkedIn (fora do fluxo de `/diaria-5-publicacao`, que não publica o É IA?
 * lá). Ver `scripts/lib/eia-linkedin-card.ts` pro desenho e pro porquê de
 * existirem dois formatos.
 *
 * Entrada: `01-eia-A.jpg` e `01-eia-B.jpg` da edição (produzidos por
 * `eia-compose.ts` no Stage 3). Nenhum dos dois é modificado.
 *
 * Uso:
 *   npx tsx scripts/gen-eia-linkedin-cards.ts --edition AAMMDD [--out-dir <path>] [--force]
 *
 * Saída (raiz da edição):
 *   01-eia-linkedin-ab.jpg   composto 4:5, A em cima e B embaixo (recomendado)
 *   01-eia-linkedin-A.jpg    avulso 4:5 da opção A
 *   01-eia-linkedin-B.jpg    avulso 4:5 da opção B
 *
 * Sem `--force`, pula o que já existe (idempotente por existência de arquivo:
 * as fotos de origem são imutáveis depois do gate do Stage 4 — regerar só
 * faz sentido quando o DESENHO do card muda, e aí `--force` é explícito).
 *
 * Fonte de marca ausente é erro duro (`assertBrandSerifAvailable`, #4090):
 * sem Georgia o rodapé sai fora da marca em silêncio.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { runMain } from "./lib/exit-handler.ts";
import { assertBrandSerifAvailable } from "./lib/shared/assert-brand-font.ts";
import {
  renderEiaCompositeCard,
  renderEiaSingleCard,
  type EiaOption,
} from "./lib/eia-linkedin-card.ts";

export const COMPOSITE_FILENAME = "01-eia-linkedin-ab.jpg";

export function singleFilename(letter: EiaOption): string {
  return `01-eia-linkedin-${letter}.jpg`;
}

export interface GenEiaLinkedinCardsResult {
  generated: string[];
  skipped: string[];
}

export async function genEiaLinkedinCards(
  dir: string,
  opts: { force?: boolean } = {},
): Promise<GenEiaLinkedinCardsResult> {
  const sources: Record<EiaOption, string> = {
    A: resolve(dir, "01-eia-A.jpg"),
    B: resolve(dir, "01-eia-B.jpg"),
  };
  for (const [letter, path] of Object.entries(sources)) {
    if (!existsSync(path)) {
      throw new Error(
        `Foto da opção ${letter} não encontrada: ${path} — rode o Stage 3 (eia-compose.ts) antes.`,
      );
    }
  }

  const generated: string[] = [];
  const skipped: string[] = [];

  const composite = resolve(dir, COMPOSITE_FILENAME);
  if (!opts.force && existsSync(composite)) {
    skipped.push(composite);
  } else {
    await renderEiaCompositeCard(sources.A, sources.B, composite);
    generated.push(composite);
  }

  for (const letter of ["A", "B"] as const) {
    const out = resolve(dir, singleFilename(letter));
    if (!opts.force && existsSync(out)) {
      skipped.push(out);
      continue;
    }
    await renderEiaSingleCard(sources[letter], letter, out);
    generated.push(out);
  }

  return { generated, skipped };
}

async function main(): Promise<void> {
  const args = parseArgsSimple(process.argv.slice(2));
  const dir = args["out-dir"]
    ? resolve(args["out-dir"])
    : editionDir(args.edition ?? "");

  await assertBrandSerifAvailable("gen-eia-linkedin-cards");

  // `hasFlag` guarda a flag SEM o prefixo `--` (ver parseArgs).
  const result = await genEiaLinkedinCards(dir, {
    force: hasFlag(process.argv.slice(2), "force"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}
