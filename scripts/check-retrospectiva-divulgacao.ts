/**
 * scripts/check-retrospectiva-divulgacao.ts (#9474)
 *
 * Checagem mecânica dos textos de divulgação da Retrospectiva ANTES do gate
 * (Passo 1 de `/diaria-mensal-apoiadores`) e antes de o editor colar o post do
 * perfil no composer (Passo 6.2):
 *
 *   - valida `--skip` (`parseRetrospectivaSkip` — token desconhecido é erro,
 *     nunca "não pulou nada");
 *   - roda `publicPostCtaProblems` nos DOIS posts públicos de LinkedIn
 *     (`divulgacao/linkedin-pagina.md` e `divulgacao/linkedin-perfil.md`): a
 *     linha literal de CTA pro apoia.se tem que estar lá, e a URL da
 *     retrospectiva paywalled nunca. O post da página ainda é rechecado por
 *     `publish-retrospectiva-linkedin.ts` no dispatch; o do PERFIL é colado à
 *     mão, então esta é a única barreira mecânica dele (achado do review do
 *     PR #9475).
 *
 * Uso:
 *   npx tsx scripts/check-retrospectiva-divulgacao.ts --cycle 2609-10 [--skip linkedin,...]
 *
 * Exit: 0 = ok; 1 = texto reprovado ou ausente; 2 = uso (`--skip` inválido).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { monthlyDir, requireMonthlyCycleArg } from "./lib/mensal/monthly-paths.ts";
import { parseRetrospectivaSkip, publicPostCtaProblems, socialPublicTextProblems, SOCIAL_PUBLIC_TEXT_FILES } from "./lib/mensal/retrospectiva-divulgacao.ts";

export interface DivulgacaoTextCheck {
  file: string;
  problems: string[];
}

/** Corpo testável: problemas por arquivo de post público não pulado. */
export function checkRetrospectivaDivulgacaoTexts(cycleDir: string, skipArg: string | undefined): DivulgacaoTextCheck[] {
  const skip = parseRetrospectivaSkip(skipArg);
  const targets: Array<{ channel: "linkedin_pagina" | "linkedin_perfil" | keyof typeof SOCIAL_PUBLIC_TEXT_FILES; file: string }> = [
    { channel: "linkedin_pagina", file: "linkedin-pagina.md" },
    { channel: "linkedin_perfil", file: "linkedin-perfil.md" },
    ...(Object.entries(SOCIAL_PUBLIC_TEXT_FILES) as Array<[keyof typeof SOCIAL_PUBLIC_TEXT_FILES, string]>).map(([channel, file]) => ({
      channel,
      file,
    })),
  ];
  const out: DivulgacaoTextCheck[] = [];
  for (const t of targets) {
    if (skip.has(t.channel)) continue;
    const path = resolve(cycleDir, "divulgacao", t.file);
    if (!existsSync(path)) {
      out.push({ file: path, problems: ["arquivo ausente — o Passo 1 (geração de textos) precisa rodar antes"] });
      continue;
    }
    const text = readFileSync(path, "utf8");
    out.push({
      file: path,
      problems: t.channel in SOCIAL_PUBLIC_TEXT_FILES
        ? socialPublicTextProblems(t.channel as keyof typeof SOCIAL_PUBLIC_TEXT_FILES, text)
        : publicPostCtaProblems(text),
    });
  }
  return out;
}

function main(): void {
  const argv = process.argv.slice(2);
  const cycle = requireMonthlyCycleArg(argv);
  let checks: DivulgacaoTextCheck[];
  try {
    checks = checkRetrospectivaDivulgacaoTexts(monthlyDir(cycle), getStringArg(argv, "skip", { example: "apoiase,linkedin" }));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  let bad = 0;
  for (const c of checks) {
    if (c.problems.length === 0) {
      console.log(`OK  ${c.file}`);
    } else {
      bad++;
      console.error(`REPROVADO  ${c.file}\n  - ${c.problems.join("\n  - ")}`);
    }
  }
  process.exitCode = bad > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main();
}
