#!/usr/bin/env npx tsx
/**
 * machine-id.ts (#3033)
 *
 * Identificador determinístico da máquina local — usado para taggear estado de
 * progresso live (`plan.json` de `/diaria-develop`) que vive em `data/`, um
 * junction do OneDrive sincronizado ENTRE máquinas (ver CLAUDE.md § Setup).
 *
 * Contexto (#3033): `data/develop/{AAMMDD}/plan.json` de uma sessão numa
 * máquina A aparece no disco da máquina B via sync do OneDrive. Sem um jeito
 * de saber "esse plan.json é da MINHA sessão ou de outra máquina", a
 * statusLine da máquina B mostrava o progresso de develop da máquina A como
 * se fosse dela — inclusive travado ali depois da sessão de A terminar.
 *
 * Sinal escolhido: `os.hostname()` — não há convenção prévia de identidade de
 * máquina neste repo (grep por `hostname`/`COMPUTERNAME`/`machine_id` não
 * encontrou nada antes deste arquivo); hostname é o sinal nativo do Node,
 * determinístico por máquina, sem dependência externa nem custo de setup.
 * Não é à prova de spoofing nem sobrevive a rename de hostname — não
 * precisa: o objetivo é só distinguir "minha máquina" de "outra máquina" no
 * caso comum (2 computadores do editor no mesmo OneDrive), não autenticação.
 *
 * Uso (skills que escrevem `plan.json` de develop/overnight):
 *   ```
 *   npx tsx scripts/lib/machine-id.ts
 *   # → imprime o hostname em stdout (nunca lança; string vazia em falha)
 *   ```
 *   Gravar o valor no campo `machine_id` de `plan.json` ao criar/atualizar o
 *   arquivo — ver `.claude/skills/diaria-develop/SKILL.md` § `plan.json`.
 *
 * Uso programático:
 *   ```ts
 *   import { getMachineId } from "./lib/machine-id.ts";
 *   const id = getMachineId();
 *   ```
 *
 * @see scripts/overnight-statusline.ts — `isForeignDevelopPlan` consome o valor.
 * @see scripts/lib/exec-mode.ts — padrão irmão (sinal determinístico + CLI entrypoint).
 */

import { hostname } from "node:os";
import { isMainModule } from "./cli-args.ts";

/**
 * Retorna o hostname da máquina local, ou string vazia em caso de erro.
 *
 * Fail-open por design (mesmo padrão do resto do arquivo de statusline): um
 * hostname ilegível nunca deve lançar — o caller trata string vazia como
 * "identidade desconhecida" e não filtra nada com base nela (ver
 * `isForeignDevelopPlan`).
 */
export function getMachineId(): string {
  try {
    return hostname() || "";
  } catch {
    return "";
  }
}

/** Hostname do Neo (máquina Windows do editor), comparado sem caixa. */
export const NEO_MACHINE_ID = "neo";

/**
 * #12983 — "esta sessão roda no Neo?", para o que só faz sentido lá (check de
 * prontidão da contingência no Passo 0 de `/diaria-edicao`). Mesmo sinal do
 * resto do arquivo: hostname, sem autenticação. Não decide papel no failover:
 * o gate do lease usa a flag explícita `--failover-standby`, nunca o hostname
 * (`scripts/lib/failover/task-gate.ts`).
 */
export function isNeoMachine(id: string = getMachineId()): boolean {
  return id.trim().toLowerCase() === NEO_MACHINE_ID;
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (isMainModule(import.meta.url)) {
  process.stdout.write(getMachineId() + "\n");
}
