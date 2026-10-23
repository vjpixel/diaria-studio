#!/usr/bin/env npx tsx
/**
 * sync-issue-labels.ts (#10618, fatia 4)
 *
 * Cria num repo da allowlist `issue_repos` as labels de issue que o tooling
 * das rodadas usa (track, motivo, prioridade, tipo) e que ainda não existem
 * lá. A lista vem do código (`scripts/lib/issue-label-sync.ts`), cor e
 * descrição são copiadas do diaria-studio. Idempotente: só cria o que falta,
 * nunca edita nem apaga label existente.
 *
 * Uso:
 *   npx tsx scripts/sync-issue-labels.ts --repo vjpixel/diaria-design --dry-run
 *   npx tsx scripts/sync-issue-labels.ts --repo vjpixel/diaria-design --apply
 *
 * Sem `--apply` nada é escrito (o default é o dry-run). Exit 0 = ok (ou nada a
 * fazer), 1 = alguma criação falhou, 2 = uso incorreto / leitura das labels
 * falhou / repo fora de `issue_repos`.
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { DEFAULT_ISSUE_REPO, ISSUE_REPOS_CONFIG_ROOT, loadIssueRepos, normalizeRepoSlug } from "./lib/issue-repos.ts";
import { planLabelSync, requiredIssueLabels, type LabelInfo } from "./lib/issue-label-sync.ts";

export type GhRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };

function defaultRunner(args: string[]) {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: 30_000 });
  return {
    status: r.error ? null : r.status,
    stdout: r.stdout ?? "",
    stderr: r.error ? r.error.message : (r.stderr ?? ""),
  };
}

function listLabels(repo: string, run: GhRunner): LabelInfo[] | string {
  const r = run(["label", "list", "-R", repo, "--limit", "500", "--json", "name,color,description"]);
  if (r.status !== 0) return `gh label list -R ${repo} falhou: ${r.stderr.trim() || `status ${r.status}`}`;
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(parsed)) return `gh label list -R ${repo}: resposta não é array`;
    return parsed.filter((l): l is LabelInfo => !!l && typeof (l as LabelInfo).name === "string");
  } catch (e) {
    return `gh label list -R ${repo}: JSON malformado (${(e as Error).message})`;
  }
}

/**
 * `_cwd` fica na assinatura por compatibilidade, mas a allowlist NÃO sai dele
 * (#10990): rodado do checkout do diaria-design (sem `platform.config.json`),
 * ler a allowlist pelo cwd caía no default só-studio e recusava o próprio design.
 */
export function main(argv: string[], _cwd: string, run: GhRunner = defaultRunner): number {
  const { values, flags } = parseArgs(argv);
  const repo = normalizeRepoSlug(values.repo);
  if (!repo) {
    console.error("[sync-issue-labels] uso: --repo owner/name [--dry-run | --apply] [--source owner/name]");
    return 2;
  }
  if (!loadIssueRepos(ISSUE_REPOS_CONFIG_ROOT).includes(repo)) {
    console.error(`[sync-issue-labels] ${repo} está fora de platform.config.json → issue_repos; nada a sincronizar.`);
    return 2;
  }
  // `--source` presente mas ilegível é erro de uso — nunca cai no default
  // em silêncio (copiaria cor/descrição de um repo que ninguém pediu).
  if (flags.has("source") || values.source === "" || (values.source !== undefined && !normalizeRepoSlug(values.source))) {
    console.error(`[sync-issue-labels] --source inválido: "${values.source ?? ""}" (esperado owner/name)`);
    return 2;
  }
  const source = normalizeRepoSlug(values.source) ?? DEFAULT_ISSUE_REPO;
  const apply = flags.has("apply");
  if (apply && flags.has("dry-run")) {
    console.error("[sync-issue-labels] --apply e --dry-run juntos: escolha um.");
    return 2;
  }

  const target = listLabels(repo, run);
  if (typeof target === "string") {
    console.error(`[sync-issue-labels] ${target}`);
    return 2;
  }
  const sourceLabels = repo === source ? target : listLabels(source, run);
  if (typeof sourceLabels === "string") {
    console.error(`[sync-issue-labels] ${sourceLabels}`);
    return 2;
  }

  const plan = planLabelSync(requiredIssueLabels(), target, sourceLabels);
  const mode = apply ? "apply" : "dry-run";
  console.log(`[sync-issue-labels] ${repo} (${mode}): ${plan.present.length} já existem, ${plan.create.length} a criar.`);
  for (const l of plan.create) {
    const origem = l.fromSource ? `cor/descrição de ${source}` : "não existe em " + source + ", cor neutra";
    console.log(`  + ${l.name}  #${l.color}  ${l.description ? `"${l.description}"` : "(sem descrição)"}  [${origem}]`);
  }
  if (!apply) {
    if (plan.create.length > 0) console.log(`[sync-issue-labels] dry-run: nada foi criado. Rode com --apply para criar.`);
    return 0;
  }

  let failed = 0;
  for (const l of plan.create) {
    const args = ["label", "create", l.name, "-R", repo, "--color", l.color];
    if (l.description) args.push("--description", l.description);
    const r = run(args);
    if (r.status === 0) {
      console.log(`  criada: ${l.name}`);
    } else if (/already exists/i.test(r.stderr)) {
      // Corrida com outra execução: a label passou a existir — idempotente.
      console.log(`  já existia: ${l.name}`);
    } else {
      failed += 1;
      console.error(`  FALHOU: ${l.name} — ${r.stderr.trim() || `status ${r.status}`}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
