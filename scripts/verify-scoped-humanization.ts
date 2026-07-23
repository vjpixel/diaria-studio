#!/usr/bin/env npx tsx
/**
 * verify-scoped-humanization.ts (#3446)
 *
 * Verifica que uma re-humanização SCOPED de `03-social.md` (Stage 4, §4d.1)
 * tocou EXATAMENTE as seções pedidas — nem menos (humanizador ignorou o
 * alvo) nem mais (mudou seções que deveriam ficar intactas). Sem este guard,
 * "re-humanizar só o D2" viraria uma promessa não-verificada — se a skill
 * humanizador reescrever o arquivo inteiro mesmo assim, o corte de tokens
 * (#3446/#3379) não se realiza, e vice-versa: se ela pular o D2 pedido, o
 * bug original (#2148 — seção não coberta escapando pro gate) volta.
 *
 * Uso:
 *   npx tsx scripts/verify-scoped-humanization.ts \
 *     --pre <path-antes-da-humanização> \
 *     --post <path-depois-da-humanização, geralmente 03-social.md> \
 *     --sections main_d2,comment_pixel_d2
 *
 * Exit code:
 *   0 = ok — apenas as seções pedidas mudaram, e todas elas mudaram
 *   1 = escopo violado (untouchedTargets e/ou unexpectedChanges não-vazios)
 *       ou erro de args/leitura
 *
 * Integração (orchestrator-stage-4.md §4d.1):
 *   1. Antes de invocar a skill humanizador em modo scoped, copiar
 *      `03-social.md` pra um snapshot (`cp 03-social.md _internal/.stage4-pre-scoped-humanize.md`).
 *   2. Invocar a skill humanizador pedindo EXPLICITAMENTE que só as seções-alvo
 *      sejam tocadas.
 *   3. Rodar este script comparando o snapshot (--pre) contra o snapshot
 *      pós-humanizador/pré-Clarice (--post = `_internal/03-social-post-humanizador.md`,
 *      #3947), com --sections = a mesma lista pedida. **NUNCA usar o
 *      `03-social.md` FINAL como --post** (#3953) — a Clarice roda ENTRE a
 *      humanização e este check (corrigindo `## post_pixel`); se ela reverter
 *      a seção de volta pra perto do estado pré-humanizador desta rodada, o
 *      `03-social.md` final deixa de refletir o que o humanizador de fato fez,
 *      e comparar contra ele produz o mesmo falso-positivo `untouchedTargets`
 *      do #3929/#3947 — só que neste check em vez do `humanizer-section-coverage`.
 *   4. Exit 1 → não confiar no resultado: se `unexpectedChanges` não-vazio,
 *      considerar re-humanização completa (a skill não respeitou o escopo);
 *      se `untouchedTargets` não-vazio, re-invocar a skill apenas para essas
 *      seções antes de seguir.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { checkScopedHumanizerCoverage } from "./lib/social-lint-rules.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const prePath = values["pre"];
  const postPath = values["post"];
  const sectionsArg = values["sections"];

  if (!prePath || !postPath || !sectionsArg) {
    console.error(
      "Uso: verify-scoped-humanization.ts --pre <path> --post <path> --sections main_d2,comment_pixel_d2",
    );
    process.exit(1);
  }

  const resolvedPre = resolve(ROOT, prePath);
  const resolvedPost = resolve(ROOT, postPath);

  if (!existsSync(resolvedPre) || !existsSync(resolvedPost)) {
    console.error(
      `[verify-scoped-humanization] ERRO: arquivo ausente — pre=${existsSync(resolvedPre)} post=${existsSync(resolvedPost)}`,
    );
    process.exit(1);
  }

  const targetSections = sectionsArg.split(",").map((s) => s.trim()).filter(Boolean);
  const preMd = readFileSync(resolvedPre, "utf8");
  const postMd = readFileSync(resolvedPost, "utf8");

  const result = checkScopedHumanizerCoverage(preMd, postMd, targetSections);

  console.log(JSON.stringify(result));

  if (result.ok) {
    console.error(
      `[verify-scoped-humanization] OK — humanizador tocou exatamente as seções pedidas: ${targetSections.join(", ")}`,
    );
    process.exit(0);
  }

  if (result.untouchedTargets.length > 0) {
    console.error(
      `[verify-scoped-humanization] FAIL — seção(ões)-alvo NÃO tocada(s) pelo humanizador: ${result.untouchedTargets.join(", ")}. ` +
      "Re-invocar a skill humanizador apenas para essas seções antes de gravar o sentinel.",
    );
  }
  if (result.unexpectedChanges.length > 0) {
    console.error(
      `[verify-scoped-humanization] FAIL — seção(ões) FORA do escopo pedido também mudaram: ${result.unexpectedChanges.join(", ")}. ` +
      "O escopo não foi respeitado — considerar tratar como re-humanização completa (gravar sentinel full-file).",
    );
  }
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main();
}
