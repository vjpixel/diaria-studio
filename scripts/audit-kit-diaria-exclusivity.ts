#!/usr/bin/env node
/**
 * audit-kit-diaria-exclusivity.ts (#6582 item 5)
 *
 * Auditoria INDEPENDENTE do invariante de exclusividade do canal Kit
 * paralelo (`kit_diaria`) — responde as duas perguntas do item 5 da issue:
 *
 * 1. Existe alguém na tag do Kit que NÃO está ativo na Beehiiv? (esperado —
 *    é a própria definição da onda, ver `platform.config.json` →
 *    `kit_diaria.audience_tag_note`)
 * 2. Existe alguém ATIVO na Beehiiv que também está na tag do Kit? (a
 *    direção PERIGOSA — edição em DOBRO, e a direção que
 *    `decideKitChannelDispatch` NÃO protege, porque ele só guarda no nível
 *    GLOBAL de backend, nunca por tag — achado do review da PR #6491,
 *    citado no mesmo `audience_tag_note`)
 *
 * Miolo puro (comparação de conjuntos) em
 * `scripts/lib/kit-diaria-audience-exclusivity.ts` — este script só faz o
 * fetch (Kit: paginação de `GET /v4/tags/{id}/subscribers` via
 * `listTagSubscribersPage`; Beehiiv: `fetchActiveBeehiivEmails`, já
 * exportado por `reconcile-beehiiv-kit.ts`, reusado aqui em vez de
 * duplicado) e delega.
 *
 * Uso:
 *   npx tsx scripts/audit-kit-diaria-exclusivity.ts             # texto humano
 *   npx tsx scripts/audit-kit-diaria-exclusivity.ts --json      # JSON pra consumo programático
 *   npx tsx scripts/audit-kit-diaria-exclusivity.ts --tag rampa-kit  # override do nome da tag
 *
 * Exit codes (mesmo espírito de `reconcile-beehiiv-kit.ts`):
 *   0 = nenhuma sobreposição (partição íntegra)
 *   1 = BLOQUEANTE — alguém está na tag do Kit E ativo na Beehiiv (dobro)
 *   2 = falha de config/rede — não foi possível medir (NUNCA confundir com "medi e não diverge")
 *
 * `--json` emite JSON em TODOS os exit codes (mesma disciplina do #6311
 * aplicada ali) — nunca stdout vazio quando a flag está presente.
 *
 * **Residual documentado (item 5 da issue, aceito explicitamente no PR):**
 * este script mede o estado ATUAL sob demanda — não roda automaticamente em
 * nenhum stage/gate ainda. Rodar manualmente após cada onda de migração
 * (#6504 e as que seguirem), ou agendar como task se o volume de ondas
 * justificar. Fechar esse gap (rodar automaticamente) fica fora do escopo
 * deste fix — a issue já sinalizava que o item podia ficar de fora se
 * grande demais, e "auditoria sob demanda executável" é o que estava
 * faltando (não existia comando NENHUM antes deste script).
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveBeehiivConfig } from "./lib/beehiiv-config.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { findTagIdByName, listTagSubscribersPage } from "./lib/kit-broadcasts.ts";
import { fetchActiveBeehiivEmails } from "./reconcile-beehiiv-kit.ts";
import { KIT_NATIVE_SIGNUP_MARKER } from "./lib/shared/kit-signup-origin.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import {
  auditKitTagAgainstBeehiivActive,
  decideAuditExitCode,
  maskAuditResult,
  formatAuditReport,
} from "./lib/kit-diaria-audience-exclusivity.ts";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_PREFIX = "[audit-kit-diaria-exclusivity]";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Lê `kit_diaria.audience_tag` de `platform.config.json` — mesmo default
 *  (`"kit-nativo"`) de `kit-diaria-channel.ts`/`kit-diaria-stage5-dispatch.ts`
 *  quando ausente. `--tag` na CLI sobrepõe (útil pra auditar uma tag
 *  diferente sem editar o config, ex: rollout escalonado). */
function resolveConfiguredAudienceTag(): string {
  try {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
      kit_diaria?: { audience_tag?: string };
    };
    return cfg.kit_diaria?.audience_tag ?? KIT_NATIVE_SIGNUP_MARKER;
  } catch {
    return KIT_NATIVE_SIGNUP_MARKER;
  }
}

/** I/O: pagina TODOS os membros de uma tag do Kit. */
async function fetchKitTagEmails(tagId: number): Promise<string[]> {
  const out: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await listTagSubscribersPage(tagId, { perPage: 500, after });
    for (const s of page.subscribers) out.push(s.email_address);
    if (!page.pagination.has_next_page || !page.pagination.end_cursor) break;
    after = page.pagination.end_cursor;
  }
  return out;
}

export function emitError(asJson: boolean, humanMessage: string, code: "config" | "network"): void {
  process.stderr.write(`${humanMessage}\n`);
  if (asJson) {
    process.stdout.write(
      JSON.stringify({ error: { code, message: humanMessage }, decision: { exitCode: 2 } }, null, 2) + "\n",
    );
  }
  process.exitCode = 2;
}

async function main(): Promise<void> {
  loadProjectEnv();
  const argv = process.argv.slice(2);
  const asJson = hasFlag(argv, "json");
  const tagArg = getArg(argv, "tag");
  const tagName = tagArg !== "" ? tagArg : resolveConfiguredAudienceTag();

  const beehiivConfig = resolveBeehiivConfig();
  if (!beehiivConfig.ok) {
    emitError(asJson, `${LOG_PREFIX} config Beehiiv inválida — não foi possível medir: ${beehiivConfig.reason}`, "config");
    return;
  }
  const kitConfig = resolveKitConfig();
  if (!kitConfig.ok) {
    emitError(asJson, `${LOG_PREFIX} config Kit inválida — não foi possível medir: ${kitConfig.reason}`, "config");
    return;
  }

  let tagId: number | null;
  try {
    process.stderr.write(`${LOG_PREFIX} resolvendo tag "${tagName}"…\n`);
    tagId = await findTagIdByName(tagName, kitConfig.config);
  } catch (e) {
    emitError(asJson, `${LOG_PREFIX} falha ao resolver a tag — não foi possível medir: ${(e as Error).message}`, "network");
    return;
  }
  if (tagId === null) {
    emitError(
      asJson,
      `${LOG_PREFIX} tag "${tagName}" não existe no Kit — não há o que auditar (config/nome errado, ou tag ainda não criada).`,
      "config",
    );
    return;
  }

  let kitTagEmails: string[];
  let beehiivActiveEmails: string[];
  try {
    process.stderr.write(`${LOG_PREFIX} buscando membros da tag "${tagName}" (id=${tagId})…\n`);
    kitTagEmails = await fetchKitTagEmails(tagId);
    process.stderr.write(`${LOG_PREFIX} buscando ativos na Beehiiv…\n`);
    beehiivActiveEmails = await fetchActiveBeehiivEmails(beehiivConfig.config.apiKey, beehiivConfig.config.publicationId);
  } catch (e) {
    emitError(asJson, `${LOG_PREFIX} falha de rede/API — não foi possível medir: ${(e as Error).message}`, "network");
    return;
  }

  const result = auditKitTagAgainstBeehiivActive(kitTagEmails, beehiivActiveEmails);
  const decision = decideAuditExitCode(result);

  if (asJson) {
    process.stdout.write(JSON.stringify({ tag: tagName, tagId, result: maskAuditResult(result), decision }, null, 2) + "\n");
  } else {
    process.stdout.write(`${LOG_PREFIX} tag "${tagName}" (id=${tagId})\n` + formatAuditReport(result, decision) + "\n");
  }

  process.exitCode = decision.exitCode;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    emitError(
      hasFlag(process.argv.slice(2), "json"),
      `${LOG_PREFIX} erro fatal — não foi possível medir: ${(e as Error).message}`,
      "network",
    );
  });
}
