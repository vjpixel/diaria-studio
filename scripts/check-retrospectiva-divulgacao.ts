/**
 * scripts/check-retrospectiva-divulgacao.ts (#9474, #9508)
 *
 * Checagem mecânica dos textos de divulgação da Retrospectiva ANTES do gate
 * (Passo 1 de `/diaria-mensal-apoiadores`) e antes de o editor colar o post do
 * perfil no composer (Passo 6):
 *
 *   - valida `--skip` (`parseRetrospectivaSkip` — token desconhecido é erro,
 *     nunca "não pulou nada");
 *   - roda `publicPostCtaProblems` no post do PERFIL LinkedIn
 *     (`divulgacao/linkedin-perfil.md`, 1 post só): a linha literal de CTA pro
 *     apoia.se tem que estar lá, e a URL da retrospectiva paywalled nunca. É
 *     colado à mão, então esta é a única barreira mecânica dele;
 *   - #9508: por história com algum post pedido, `divulgacao/d{N}.md`
 *     (`retrospectivaHistoriaBodyProblems` — exatamente 3 parágrafos, ≤260
 *     cada, nenhum slide transbordando o card, sem CTA/URL paywalled/markdown
 *     — mais a legenda composta de LinkedIn/Facebook/Instagram), o título da
 *     capa (`draft.md`, cabe a 62px) e `divulgacao/d{N}-curto.md` (Threads/X:
 *     CTA curto + teto de 280) — pra que o gate só mostre texto que
 *     `publish-retrospectiva-social.ts` aceitaria.
 *
 * Uso:
 *   npx tsx scripts/check-retrospectiva-divulgacao.ts --cycle 2609-10 [--skip linkedin,x,instagram:d2,...]
 *
 * Exit: 0 = ok; 1 = texto reprovado ou ausente; 2 = uso (`--skip` inválido).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { monthlyDir, requireMonthlyCycleArg } from "./lib/mensal/monthly-paths.ts";
import { extractDestaqueTitle } from "./lib/mensal/monthly-apoiadores-kit-render.ts";
import {
  RETROSPECTIVA_HISTORIAS,
  RETROSPECTIVA_POST_CHANNELS,
  parseRetrospectivaSkip,
  publicPostCtaProblems,
  retrospectivaPostKey,
} from "./lib/mensal/retrospectiva-divulgacao.ts";
import {
  isShortChannel,
  retrospectivaHistoriaBodyProblems,
  retrospectivaHistoriaFiles,
  retrospectivaPostText,
  retrospectivaSocialPostProblems,
} from "./lib/mensal/retrospectiva-social.ts";
import { retrospectivaCoverTitleFits } from "./lib/mensal/retrospectiva-cards.ts";

export interface DivulgacaoTextCheck {
  file: string;
  problems: string[];
}

/** Corpo testável: problemas por arquivo de post público não pulado. */
export function checkRetrospectivaDivulgacaoTexts(cycleDir: string, skipArg: string | undefined): DivulgacaoTextCheck[] {
  const skip = parseRetrospectivaSkip(skipArg);
  const out: DivulgacaoTextCheck[] = [];
  const read = (file: string): string | undefined => {
    const p = resolve(cycleDir, "divulgacao", file);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  };
  const absent = (file: string): DivulgacaoTextCheck => ({
    file: resolve(cycleDir, "divulgacao", file),
    problems: ["arquivo ausente — o Passo 1 (geração de textos) precisa rodar antes"],
  });

  if (!skip.has("linkedin_perfil")) {
    const t = read("linkedin-perfil.md");
    out.push(t === undefined ? absent("linkedin-perfil.md") : { file: resolve(cycleDir, "divulgacao", "linkedin-perfil.md"), problems: publicPostCtaProblems(t) });
  }

  const draftPath = resolve(cycleDir, "draft.md");
  const draft = existsSync(draftPath) ? readFileSync(draftPath, "utf8") : null;
  RETROSPECTIVA_HISTORIAS.forEach((h, i) => {
    const channels = RETROSPECTIVA_POST_CHANNELS.filter((ch) => !skip.has(retrospectivaPostKey(ch, h)));
    if (channels.length === 0) return;
    const files = retrospectivaHistoriaFiles(h);

    const title = draft === null ? null : extractDestaqueTitle(draft, i + 1);
    const titleProblems =
      title === null
        ? [`título da DESTAQUE ${i + 1} não encontrado em draft.md — é o título da capa`]
        : retrospectivaCoverTitleFits(title)
          ? []
          : [`título "${title}" não cabe na capa a 62px — reescreva-o no draft (#8589)`];
    if (titleProblems.length > 0) out.push({ file: `${draftPath} (DESTAQUE ${i + 1})`, problems: titleProblems });

    const corpo = read(files.corpo);
    if (corpo === undefined) out.push(absent(files.corpo));
    else {
      const problems = retrospectivaHistoriaBodyProblems(corpo);
      for (const ch of channels.filter((c) => !isShortChannel(c))) {
        for (const p of retrospectivaSocialPostProblems(ch, retrospectivaPostText(ch, { corpo })!)) problems.push(`${ch}: ${p}`);
      }
      out.push({ file: resolve(cycleDir, "divulgacao", files.corpo), problems });
    }

    const short = channels.filter(isShortChannel);
    if (short.length > 0) {
      const curto = read(files.curto);
      if (curto === undefined) out.push(absent(files.curto));
      else
        out.push({
          file: resolve(cycleDir, "divulgacao", files.curto),
          problems: short.flatMap((ch) => retrospectivaSocialPostProblems(ch, curto).map((p) => `${ch}: ${p}`)),
        });
    }
  });
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
