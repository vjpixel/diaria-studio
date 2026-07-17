/**
 * lint-social-md.ts (#602, #877)
 *
 * Valida regras invariáveis do `03-social.md`. Dois modos:
 *
 * 1. Default (sem `--check`): valida CTAs (#602)
 *    - LinkedIn CTA termina com `diar.ia.br` (sem `https://`, sem `.` final)
 *    - Facebook CTA termina com `https://diar.ia.br.` (com prefixo + ponto)
 *
 *    Regras opostas entre plataformas — agent confunde sem validação
 *    determinística.
 *
 * 2. `--check relative-time` (#877): valida timestamps relativos (defense-in-depth)
 *    - Detecta "hoje", "ontem", "há N dias", "esta semana", etc.
 *    - Posts vão pra fila com D+1+ delay; relativos envelhecem mal.
 *
 * IMPORTANTE: o flag `--check relative-time` é OBRIGATÓRIO pra validação de
 * timestamps. SEM o flag, o lint só checa CTAs e ignora qualquer "hoje" /
 * "ontem" no MD. Se o orchestrator esquecer o flag, posts com timestamps
 * relativos passam pelo gate sem warning.
 *
 * Uso:
 *   # Default — checa CTAs
 *   npx tsx scripts/lint-social-md.ts --md data/editions/260505/03-social.md
 *
 *   # Modo relative-time — checa timestamps narrativos
 *   npx tsx scripts/lint-social-md.ts --check relative-time --md <path>
 *
 * Exit code:
 *   0 = ok
 *   1 = lint errors (bloqueia gate)
 *   2 = uso inválido
 *
 * #2833: as regras individuais de lint (cada `lint*`/`check*`) foram
 * extraídas pra scripts/lib/social-lint-rules.ts — movimentação pura,
 * re-exportadas abaixo pra manter compat com importadores existentes. Este
 * arquivo mantém só o parser de args e o runner/CLI (`main`).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseArgsStructured, isMainModule } from "./lib/cli-args.ts"; // #2834
import {
  type LintError,
  extractPlatformSection,
  parseDestaqueHeaders,
  lintLinkedinCTAs,
  lintFacebookCTAs,
  type LintResult,
  lintSocialMd,
  type RelativeTimeMatch,
  type RelativeTimeResult,
  lintRelativeTime,
  type LinkedinSchemaError,
  type LinkedinSchemaResult,
  lintLinkedinSchema,
  type LinkedinEmailCtaError,
  type LinkedinEmailCtaResult,
  lintLinkedinEmailCTA,
  lintInstagramEmailCTA,
  DIARIA_LINKEDIN_PAGE_SLUG,
  type LinkedinPageLinkError,
  type LinkedinPageLinkResult,
  lintLinkedinPageLink,
  CREDENTIAL_BIO_RE,
  type CredentialBioMatch,
  type CredentialBioResult,
  lintCredentialBio,
  type AntithesisRevealMatch,
  type AntithesisRevealResult,
  lintAntithesisReveal,
  type TrailingEditorialHookMatch,
  type TrailingEditorialHookResult,
  lintTrailingEditorialHook,
  EDITORIAL_HOOK_TRIGGER_RE,
  type TrailingQuestionMatch,
  type TrailingQuestionResult,
  type PostPixelMatchResult,
  lintPostPixelMatchesD1,
  lastMeaningfulSentence,
  endsWithTrailingQuestion,
  lintTrailingQuestion,
  type PersonalPostDeixisMatch,
  type PersonalPostDeixisResult,
  lintPersonalPostNewsletterDeixis,
  type SectionCoverageResult,
  checkHumanizerSectionCoverage,
  type PlatformHeaderDuplicateError,
  type PlatformHeaderUniqueResult,
  lintPlatformHeadersUnique,
  extractSocialSections,
  computeSectionHashes,
  type ScopedCoverageResult,
  checkScopedHumanizerCoverage,
} from "./lib/social-lint-rules.ts"; // #2833: extraído — movimentação pura

export type { LintError };
export { extractPlatformSection, parseDestaqueHeaders, lintLinkedinCTAs, lintFacebookCTAs };
export type { LintResult };
export { lintSocialMd };
export type { RelativeTimeMatch, RelativeTimeResult };
export { lintRelativeTime };
export type { LinkedinSchemaError, LinkedinSchemaResult };
export { lintLinkedinSchema };
export type { LinkedinEmailCtaError, LinkedinEmailCtaResult };
export { lintLinkedinEmailCTA, lintInstagramEmailCTA };
export { DIARIA_LINKEDIN_PAGE_SLUG };
export type { LinkedinPageLinkError, LinkedinPageLinkResult };
export { lintLinkedinPageLink };
export { CREDENTIAL_BIO_RE };
export type { CredentialBioMatch, CredentialBioResult };
export { lintCredentialBio };
export type { AntithesisRevealMatch, AntithesisRevealResult };
export { lintAntithesisReveal };
export type { TrailingEditorialHookMatch, TrailingEditorialHookResult };
export { lintTrailingEditorialHook };
export { EDITORIAL_HOOK_TRIGGER_RE };
export type { TrailingQuestionMatch, TrailingQuestionResult };
export type { PostPixelMatchResult };
export { lintPostPixelMatchesD1, lastMeaningfulSentence, endsWithTrailingQuestion, lintTrailingQuestion };
export type { PersonalPostDeixisMatch, PersonalPostDeixisResult };
export { lintPersonalPostNewsletterDeixis };
export type { SectionCoverageResult };
export { checkHumanizerSectionCoverage };
export type { PlatformHeaderDuplicateError, PlatformHeaderUniqueResult };
export { lintPlatformHeadersUnique };
export { extractSocialSections, computeSectionHashes };
export type { ScopedCoverageResult };
export { checkScopedHumanizerCoverage };
function main(): void {
  const args = parseArgsStructured(process.argv.slice(2)).values;
  if (!args.md) {
    console.error(
      "Uso: lint-social-md.ts --md <path>\n" +
        "  ou: lint-social-md.ts --check relative-time --md <path>\n" +
        "  ou: lint-social-md.ts --check linkedin-schema --md <path>\n" +
        "  ou: lint-social-md.ts --check post_pixel-matches-d1 --md <path>\n" +
        "  ou: lint-social-md.ts --check personal-post-no-newsletter-deixis --md <path>\n" +
        "  ou: lint-social-md.ts --check humanizer-section-coverage --pre <path-pre> --md <path-post>\n" +
        "  ou: lint-social-md.ts --check no-email-cta-linkedin --md <path>\n" +
        "  ou: lint-social-md.ts --check linkedin-page-link --md <path>\n" +
        "  ou: lint-social-md.ts --check no-credential-bio --md <path>\n" +
        "  ou: lint-social-md.ts --check no-email-cta-instagram --md <path>\n" +
        "  ou: lint-social-md.ts --check no-antithesis-reveal --md <path>\n" +
        "  ou: lint-social-md.ts --check no-trailing-editorial-hook --md <path>\n" +
        "  ou: lint-social-md.ts --check platform-headers-unicos --md <path>",
    );
    process.exit(2);
  }
  const ROOT = process.cwd();
  const mdPath = resolve(ROOT, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");

  // Modo --check relative-time (#877) — detecta timestamps relativos em posts social
  if (args.check === "relative-time") {
    const result = lintRelativeTime(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.matches.length} referência(s) temporal(is) relativa(s) detectada(s) em posts social:`,
      );
      for (const m of result.matches) {
        console.error(
          `  linha ${m.line}: relative_time: '${m.word}' encontrado — posts publicam D+1+, use data absoluta\n    contexto: "...${m.context}..."`,
        );
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check no-trailing-question (#1762) — posts não encerram com pergunta
  if (args.check === "no-trailing-question") {
    const result = lintTrailingQuestion(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.matches.length} post(s) social encerrando com pergunta (#1762 — fechar com afirmação, não CTA-pergunta):`,
      );
      for (const m of result.matches) {
        console.error(`  [${m.platform} ${m.destaque}] termina em pergunta: "...${m.sentence}"`);
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check linkedin-schema (#595, #3627) — valida o post principal por destaque
  if (args.check === "linkedin-schema") {
    const result = lintLinkedinSchema(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.errors.length} erro(s) no schema LinkedIn (main post por destaque):`,
      );
      for (const e of result.errors) console.error(`  [${e.destaque}] ${e.rule}: ${e.detail}`);
      process.exit(1);
    }
    return;
  }

  // Modo --check post_pixel-matches-d1 (#1861) — post pessoal do Pixel deve ser
  // sobre o D1 atual (não ficar stale após reorder dos destaques).
  if (args.check === "post_pixel-matches-d1") {
    const result = lintPostPixelMatchesD1(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ post_pixel desalinhado com D1 (#1861):\n  ${result.detail}`);
      process.exit(1);
    }
    return;
  }

  // Modo --check personal-post-no-newsletter-deixis (#2148) — post_pixel e
  // comment_pixel não devem usar "esta/essa/nossa newsletter" (deixis de marca
  // em post pessoal sem contexto compartilhado).
  if (args.check === "personal-post-no-newsletter-deixis") {
    const result = lintPersonalPostNewsletterDeixis(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.matches.length} ocorrência(s) de deixis de newsletter em post/comment pessoal (#2148):`,
      );
      for (const m of result.matches) {
        console.error(
          `  [${m.section}] linha ${m.line}: '${m.phrase}' — use "a newsletter de IA que escrevo", não "esta/nossa newsletter"\n    contexto: "...${m.context}..."`,
        );
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check humanizer-section-coverage (#2148) — verifica cobertura
  // por-seção do humanizador social (comments/post_pixel). Requer --pre <path>.
  if (args.check === "humanizer-section-coverage") {
    if (!args.pre) {
      console.error("Uso: lint-social-md.ts --check humanizer-section-coverage --pre <pré-humanizador> --md <pós-humanizador>");
      process.exit(2);
    }
    const prePath = resolve(process.cwd(), args.pre);
    if (!existsSync(prePath)) {
      console.error(`Arquivo pré-humanizador não existe: ${prePath}`);
      process.exit(2);
    }
    const preMd = readFileSync(prePath, "utf8");
    const result = checkHumanizerSectionCoverage(preMd, md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      if (result.deleted.length > 0) {
        console.error(
          `\n❌ ${result.deleted.length} seção(ões) deletada(s) pelo humanizador (corrupção estrutural, #2148):`,
        );
        for (const s of result.deleted) {
          console.error(`  ${s}: presente antes do humanizador, ausente depois`);
        }
      }
      if (result.untouched.length > 0) {
        console.error(
          `\n❌ ${result.untouched.length} seção(ões) não coberta(s) pelo humanizador (#2148):`,
        );
        for (const s of result.untouched) {
          console.error(`  ${s}: idêntica antes/depois do humanizador`);
        }
        console.error(`\n  Re-invocar humanizador mirando: ${result.untouched.join(", ")}`);
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check no-email-cta-linkedin (#2458) — proibe CTA de assinatura por e-mail no LinkedIn
  if (args.check === "no-email-cta-linkedin") {
    const result = lintLinkedinEmailCTA(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.errors.length} CTA(s) de e-mail encontrado(s) em posts LinkedIn (#2458 — use CTA de seguir a página, não assinatura por e-mail):`,
      );
      for (const e of result.errors) {
        console.error(`  [${e.section}] linha ${e.line}: '${e.phrase}' — substituir pelo CTA da página`);
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check no-email-cta-instagram (#2486) — proibe CTA de assinatura por e-mail
  // na seção que o Instagram consome (Instagram própria ou fallback Facebook).
  if (args.check === "no-email-cta-instagram") {
    const result = lintInstagramEmailCTA(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.errors.length} CTA(s) de e-mail encontrado(s) na copy do Instagram (#2486 — adapte o caption, sem CTA de assinatura por e-mail):`,
      );
      for (const e of result.errors) {
        console.error(`  [${e.section}] linha ${e.line}: '${e.phrase}' — remover/adaptar o CTA de e-mail`);
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check linkedin-page-link (#2458) — valida link da página em post_pixel
  // (#3645: comment_diaria deixou de ser checado — subseção não é mais gerada desde #3627)
  if (args.check === "linkedin-page-link") {
    const result = lintLinkedinPageLink(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.errors.length} seção(ões) sem link da página da Diar.ia no LinkedIn (#2458):`,
      );
      for (const e of result.errors) {
        console.error(`  [${e.section}${e.destaque ? `/${e.destaque}` : ""}]: ${e.detail}`);
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check no-credential-bio (#2494) — detecta frases de credencial/bio
  // auto-referenciais em post_pixel e comment_pixel. Warn-only (exit 1 para
  // bloquear e forçar revisão).
  if (args.check === "no-credential-bio") {
    const result = lintCredentialBio(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.matches.length} frase(s) de credencial/bio auto-referencial detectada(s) em post/comment pessoal (#2494):`,
      );
      for (const m of result.matches) {
        console.error(
          `  [${m.section}] linha ${m.line}: '${m.phrase}' — o ponto se sustenta pelo conteúdo, não pela bio\n    contexto: "...${m.context}..."`,
        );
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check no-antithesis-reveal (#2526) — detecta construções de antítese-revelação
  // em posts social. WARN-ONLY: sempre exit 0 mesmo com matches; surfaça como ⚠️ no gate.
  if (args.check === "no-antithesis-reveal") {
    const result = lintAntithesisReveal(md);
    console.log(JSON.stringify(result, null, 2));
    if (result.matches.length > 0) {
      console.error(
        `\n⚠️  ${result.matches.length} construção(ões) de antítese-revelação detectada(s) (#2526 — reescreva direto, sem negar pra revelar):`,
      );
      for (const m of result.matches) {
        console.error(
          `  linha ${m.line} [${m.pattern}]: "...${m.context}..."`,
        );
      }
      // WARN-ONLY: exit 0 mesmo com matches — não bloqueia o gate
    }
    return;
  }

  // Modo --check no-trailing-editorial-hook (#2658) — detecta ", e [gancho editorial]"
  // em posts social. WARN-ONLY: sempre exit 0 mesmo com matches; surfaça como ⚠️ no gate.
  if (args.check === "no-trailing-editorial-hook") {
    const result = lintTrailingEditorialHook(md);
    console.log(JSON.stringify(result, null, 2));
    if (result.matches.length > 0) {
      console.error(
        `\n⚠️  ${result.matches.length} gancho(s) editorial(is) detectado(s) (#2658 — mover o gancho pro corpo ou cortar a oração emendada):`,
      );
      for (const m of result.matches) {
        console.error(
          `  linha ${m.line}: "...${m.context}..."`,
        );
      }
      // WARN-ONLY: exit 0 mesmo com matches — não bloqueia o gate
    }
    return;
  }

  // Modo --check platform-headers-unicos (#3388) — falha se `# LinkedIn` ou
  // `# Facebook` aparecer mais de 1 vez em 03-social.md (header duplicado faz
  // extractPlatformSection/extractDestaqueBlock pararem cedo — ver doc em
  // lib/social-lint-rules.ts:lintPlatformHeadersUnique).
  if (args.check === "platform-headers-unicos") {
    const result = lintPlatformHeadersUnique(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.errors.length} plataforma(s) com header duplicado em 03-social.md:`,
      );
      for (const e of result.errors) {
        console.error(
          `  '${e.header}' aparece ${e.count}x (esperado: 1) — linhas ${e.lines.join(", ")}. ` +
            `Remova o(s) header(s) duplicado(s) antes de prosseguir — publish-${e.platform}.ts para de parsear no 2º header, tratando-o como o fim da seção, e reporta "Destaque não encontrado" pra todos os destaques.`,
        );
      }
      process.exit(1);
    }
    return;
  }

  // Modo default: validação de CTAs (#602)
  const result = lintSocialMd(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.errors.length} erro(s) em CTAs social:`);
    for (const e of result.errors) console.error(`  [${e.platform}] ${e.rule}: ${e.detail}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

