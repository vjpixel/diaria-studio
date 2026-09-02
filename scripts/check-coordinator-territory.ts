#!/usr/bin/env npx tsx
/**
 * check-coordinator-territory.ts (#6957)
 *
 * CLI do protocolo de duas coordenadoras com território disjunto — ver
 * `scripts/lib/coordinator-territory.ts` pro critério puro e docs completos.
 * Este arquivo só coleta os dados (registros de sessão ativa) via
 * `scripts/lib/session-registry.ts`, resolve os paths e chama a lógica pura.
 *
 * Dois modos:
 *
 *   npx tsx scripts/check-coordinator-territory.ts --check \
 *       --from-territory name=A --from-paths a.ts,b.ts \
 *       --to-territory name=B --to-paths c.ts
 *
 *   npx tsx scripts/check-coordinator-territory.ts --grant \
 *       --kind {overnight|develop|continuo} --session-id A \
 *       --granted-to B [--pr N]
 *
 * Exit codes:
 *   --check: 0 = disjunto (seguro), 1 = colide/indeterminado (não conceder)
 *   --grant: 0 = concessão feita, 1 = recusada (terreno colide, ou peer não
 *       encontrado, ou self-grant), 2 = erro de I/O / uso inválido
 *
 * A resposta (motivo) sempre vai pro stdout/stderr — exit code sozinho não
 * diz PORQUE, e quem for barrado precisa saber (mesma disciplina de
 * `check-continuo-workdir.ts` / `sensitive-path-guard.ts`).
 */

import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { resolveRepoRoot, requireCoordinatorKind, grantMergeWindow, listActiveSessions } from "./lib/session-registry.ts";
import { isTerritoryDisjoint, type Territory } from "./lib/coordinator-territory.ts";

const LOG_PREFIX = "[check-coordinator-territory]";

function territoryFromArgs(values: Record<string, string>, prefix: string, pathsKey: string): Territory {
  const rawName = values[`${prefix}-territory`];
  if (!rawName) {
    throw new Error(`--${prefix}-territory é obrigatório (ex: --${prefix}-territory name=A)`);
  }
  const eqIdx = rawName.indexOf("=");
  const name = eqIdx !== -1 ? rawName.slice(eqIdx + 1) : rawName;
  if (!name) {
    throw new Error(`--${prefix}-territory sem valor (use --${prefix}-territory name=<nome>)`);
  }
  const rawPaths = values[pathsKey];
  if (!rawPaths) {
    throw new Error(`--${pathsKey} é obrigatório (lista separada por vírgula)`);
  }
  const paths = rawPaths
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return { name, paths };
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));

  if (flags.has("check")) {
    const from = territoryFromArgs(values, "from", "from-paths");
    const to = territoryFromArgs(values, "to", "to-paths");
    const result = isTerritoryDisjoint(from, to);
    if (result.disjoint) {
      console.log(`${LOG_PREFIX} disjunto — ${result.reason}`);
      process.exit(0);
    }
    console.error(`${LOG_PREFIX} NÃO é seguro — ${result.reason}`);
    process.exit(1);
  }

  if (flags.has("grant")) {
    const kindRaw = values.kind;
    if (kindRaw === undefined) {
      throw new Error("--kind é obrigatório no modo --grant (kind da sessão CONCEDENTE)");
    }
    const kind = requireCoordinatorKind(kindRaw);
    const sessionId = values["session-id"];
    if (!sessionId) throw new Error("--session-id é obrigatório");
    const grantedTo = values["granted-to"];
    if (!grantedTo) throw new Error("--granted-to é obrigatório");
    const prRaw = values.pr;
    const pr = prRaw !== undefined ? Number(prRaw) : undefined;
    if (pr !== undefined && !Number.isInteger(pr)) throw new Error("--pr deve ser inteiro");

    const repoRoot = resolveRepoRoot();
    const sessions = listActiveSessions(repoRoot);
    const from = sessions.find((s) => s.sessionId === sessionId);
    const to = sessions.find((s) => s.sessionId === grantedTo);

    if (!from) {
      console.error(`${LOG_PREFIX} recusado — sessão concedente "${sessionId}" não está registrada/ativa`);
      process.exit(1);
    }
    if (!to) {
      console.error(`${LOG_PREFIX} recusado — sessão beneficiária "${grantedTo}" não está registrada/ativa`);
      process.exit(1);
    }

    const fromTerritory: Territory = {
      name: `${from.kind}@${from.machineTag}`,
      paths: [...(from.touched_paths ?? []), ...(from.dirty_paths ?? [])],
    };
    const toTerritory: Territory = {
      name: `${to.kind}@${to.machineTag}`,
      paths: [...(to.touched_paths ?? []), ...(to.dirty_paths ?? [])],
    };

    const check = isTerritoryDisjoint(fromTerritory, toTerritory);
    if (!check.disjoint) {
      console.error(
        `${LOG_PREFIX} grant RECUSADO antes de gravar — ${check.reason} ` +
          "(#6957 §protocolo item 2: nunca conceder grant sem checar colisão de path)",
      );
      process.exit(1);
    }
    console.log(`${LOG_PREFIX} território ok — ${check.reason}`);

    const result = grantMergeWindow(repoRoot, kind, sessionId, grantedTo, pr !== undefined ? { pr } : {});
    switch (result.reason) {
      case "granted":
        console.log(
          `${LOG_PREFIX} grant-merge ok — janela concedida a ${grantedTo}` +
            `${pr !== undefined ? ` (PR #${pr})` : ""}`,
        );
        process.exit(0);
      case "self-grant-refused":
        console.error(`${LOG_PREFIX} grant-merge RECUSADO — uma sessão nunca concede janela a si mesma (#6296)`);
        process.exit(1);
      case "not-a-coordinator":
        console.error(`${LOG_PREFIX} grant-merge RECUSADO — só coordenadora concede`);
        process.exit(1);
      case "grantee-is-coordinator-refused":
        console.error(
          `${LOG_PREFIX} grant-merge RECUSADO — ${grantedTo} é uma sessão COORDENADORA ativa (#6303)`,
        );
        process.exit(1);
      case "no-op-session-missing":
        console.error(`${LOG_PREFIX} grant-merge no-op (sessão inexistente)`);
        process.exit(1);
    }
    process.exit(1);
  }

  console.error(
    `${LOG_PREFIX} uso: --check --from-territory name=A --from-paths a.ts,b.ts --to-territory name=B --to-paths c.ts` +
      "   OU   --grant --kind {overnight|develop|continuo} --session-id A --granted-to B [--pr N]",
  );
  process.exit(2);
}
