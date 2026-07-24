/**
 * validate-stage-2-outputs.ts (#872)
 *
 * Verifica que os agents paralelos do Stage 2 (writer, social-linkedin,
 * social-facebook) escreveram seus outputs com sucesso antes de prosseguir
 * pra etapas que assumem isso (merge social, processamento newsletter).
 *
 * Bug que motivou (#872): se algum dos 3 agents falhasse silenciosamente
 * (timeout, retorno mal-formado), o merge em `03-social.md` crashava
 * lendo arquivo ausente, deixando a edição em estado quebrado sem rollback.
 *
 * #3486: `social-instagram` é um 4º agent do dispatch (gera seção `# Instagram`
 * dedicada, sem CTA de e-mail, ver `.claude/agents/social-instagram.md`), mas
 * seu tmp entra como check WARN-ONLY (não FATAL) — diferente de LinkedIn/
 * Facebook. Ausência não deixa `03-social.md` num estado quebrado (o merge
 * é tolerante, ver `merge-social-md.ts`); ela só faz o Instagram cair no
 * fallback estrutural `# Instagram` → `# Facebook` que já existia antes
 * deste agent (#2486). Um warning aqui dá visibilidade sem bloquear o
 * pipeline por um canal que tem fallback seguro.
 *
 * #3992: `social-curto` é um 5º agent do dispatch (texto único ≤280 chars
 * compartilhado por Twitter/X e Threads, ver `.claude/agents/social-curto.md`),
 * mesmo tratamento WARN-ONLY do Instagram — ausência faz `publish-threads.ts`
 * cair no fallback `# Facebook` (truncado 500 chars) e `publish-twitter.ts`
 * pular sem publicar (sem fallback, #3994).
 *
 * Uso:
 *   npx tsx scripts/validate-stage-2-outputs.ts --edition-dir data/editions/260507/
 *
 * Exit codes:
 *   0 — todos os outputs FATAL OK (Instagram ausente só gera warning em stderr)
 *   1 — algum output FATAL ausente/vazio; stderr indica qual + sugestão de fix
 */

import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface OutputCheck {
  agent: string;
  path: string;
  resumeCmd: string;
}

function main(): void {
  const args = parseArgsSimple(process.argv.slice(2));
  const editionDirArg = args["edition-dir"];
  if (!editionDirArg) {
    console.error("Erro: --edition-dir obrigatório.");
    process.exit(1);
  }

  const editionDir = resolve(ROOT, editionDirArg);
  const editionDate = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop()!;

  const checks: OutputCheck[] = [
    {
      agent: "writer",
      path: resolve(editionDir, "_internal/02-draft.md"),
      resumeCmd: `/diaria-2-escrita ${editionDate} newsletter`,
    },
    {
      agent: "social-linkedin",
      path: resolve(editionDir, "_internal/03-linkedin.tmp.md"),
      resumeCmd: `/diaria-2-escrita ${editionDate} social`,
    },
    {
      agent: "social-facebook",
      path: resolve(editionDir, "_internal/03-facebook.tmp.md"),
      resumeCmd: `/diaria-2-escrita ${editionDate} social`,
    },
  ];

  // #3486/#3992: WARN-ONLY — social-instagram e social-curto têm fallback
  // seguro/degradação tolerável, então ausência não é FATAL como os checks acima.
  const warnOnlyChecks: (OutputCheck & { fallbackNote: string })[] = [
    {
      agent: "social-instagram",
      path: resolve(editionDir, "_internal/03-instagram.tmp.md"),
      resumeCmd: `/diaria-2-escrita ${editionDate} social`,
      fallbackNote:
        "Merge vai cair no fallback '# Instagram' -> '# Facebook' (#2486) — a copy do Instagram herdará o CTA de e-mail do Facebook.",
    },
    {
      agent: "social-curto",
      path: resolve(editionDir, "_internal/03-curto.tmp.md"),
      resumeCmd: `/diaria-2-escrita ${editionDate} social`,
      fallbackNote:
        "publish-threads.ts vai cair no fallback '# Facebook' truncado (500 chars); publish-twitter.ts não publica nesta edição (sem fallback, #3994).",
    },
  ];

  const failures: { check: OutputCheck; reason: string }[] = [];

  for (const check of checks) {
    if (!existsSync(check.path)) {
      failures.push({ check, reason: "ausente" });
      continue;
    }
    const size = statSync(check.path).size;
    if (size === 0) {
      failures.push({ check, reason: "vazio (0 bytes)" });
    }
  }

  const warnings: { check: OutputCheck & { fallbackNote: string }; reason: string }[] = [];
  for (const check of warnOnlyChecks) {
    if (!existsSync(check.path)) {
      warnings.push({ check, reason: "ausente" });
    } else if (statSync(check.path).size === 0) {
      warnings.push({ check, reason: "vazio (0 bytes)" });
    }
  }

  if (failures.length === 0) {
    console.log(`validate-stage-2-outputs: OK — ${checks.length}/${checks.length} agent(s) obrigatório(s) escreveram outputs.`);
    for (const { check, reason } of warnings) {
      console.error(
        `validate-stage-2-outputs: warn — ${check.agent} ${reason}: ${check.path}\n` +
          `  ${check.fallbackNote}\n` +
          `  Recomendado: ${check.resumeCmd}`,
      );
    }
    process.exit(0);
  }

  console.error(
    `validate-stage-2-outputs: FALHOU — ${failures.length}/${checks.length} agent(s) obrigatório(s) com output inválido:\n`,
  );
  for (const { check, reason } of failures) {
    console.error(`  - ${check.agent}: ${check.path} ${reason}`);
    console.error(`    Re-rodar: ${check.resumeCmd}`);
  }
  console.error(
    `\nNão prosseguir com merge ou Clarice — outputs incompletos resultam em edição quebrada.`,
  );
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main();
}
