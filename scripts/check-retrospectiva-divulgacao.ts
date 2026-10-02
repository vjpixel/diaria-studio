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
 *     PR #9475);
 *   - #9500: roda `retrospectivaSocialPostProblems` em `divulgacao/{facebook,
 *     instagram,threads,x}.md` — mesma regra de CTA (X/Threads aceitam a
 *     linha curta) + teto de caracteres da rede (X/Threads 280), pra que o
 *     gate só mostre texto que `publish-retrospectiva-social.ts` aceitaria.
 *
 * Uso:
 *   npx tsx scripts/check-retrospectiva-divulgacao.ts --cycle 2609-10 [--skip linkedin,x,...]
 *
 * Exit: 0 = ok; 1 = texto reprovado ou ausente; 2 = uso (`--skip` inválido).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { monthlyDir, requireMonthlyCycleArg } from "./lib/mensal/monthly-paths.ts";
import { parseRetrospectivaSkip, publicPostCtaProblems, type RetrospectivaDivulgacaoChannel } from "./lib/mensal/retrospectiva-divulgacao.ts";
import {
  RETROSPECTIVA_SOCIAL_CHANNELS,
  RETROSPECTIVA_SOCIAL_TEXT_FILES,
  retrospectivaSocialPostProblems,
} from "./lib/mensal/retrospectiva-social.ts";

export interface DivulgacaoTextCheck {
  file: string;
  problems: string[];
}

/** Corpo testável: problemas por arquivo de post público não pulado. */
export function checkRetrospectivaDivulgacaoTexts(cycleDir: string, skipArg: string | undefined): DivulgacaoTextCheck[] {
  const skip = parseRetrospectivaSkip(skipArg);
  const targets: Array<{ channel: RetrospectivaDivulgacaoChannel; file: string; check: (text: string) => string[] }> = [
    { channel: "linkedin_pagina", file: "linkedin-pagina.md", check: (t) => publicPostCtaProblems(t) },
    { channel: "linkedin_perfil", file: "linkedin-perfil.md", check: (t) => publicPostCtaProblems(t) },
    // #9500 — mesma regra de CTA + teto de caracteres de cada rede.
    ...RETROSPECTIVA_SOCIAL_CHANNELS.map((ch) => ({
      channel: ch,
      file: RETROSPECTIVA_SOCIAL_TEXT_FILES[ch],
      check: (t: string) => retrospectivaSocialPostProblems(ch, t),
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
    out.push({ file: path, problems: t.check(readFileSync(path, "utf8")) });
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
