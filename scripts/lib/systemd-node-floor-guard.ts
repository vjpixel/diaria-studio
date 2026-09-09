/**
 * scripts/lib/systemd-node-floor-guard.ts (#7522)
 *
 * `buildSystemdUnitFiles` (`scripts/lib/systemd-units.ts`) passou a recusar
 * gerar (via `assertSupportedNodeVersion`) qualquer unit novo cujo
 * `ExecStart=` embutiria um node abaixo do piso do projeto (>=22.5,
 * `check-node-version.ts`) — mas isso só protege units GERADOS A PARTIR DE
 * AGORA. Units já ARMADOS em `~/.config/systemd/user/` (copiados +
 * `systemctl --user enable` antes deste fix) continuam no disco exatamente
 * como nasceram, quebrados, e o gerador nunca mais roda sobre eles até o
 * editor religar manualmente.
 *
 * Achado ao vivo (#7522, 09/09/2026): 9 units em `helios` apontavam pra
 * `/usr/bin/node` (Node 20.20.2 do sistema, abaixo do piso) — todas
 * `enabled`, incluindo 3 alarmes (`diaria-corrupted-names-weekly-check`,
 * `diaria-guard-never-invoked-weekly-check`, `diaria-task-registry-prose-
 * drift-alarm`). Alarme que não consegue rodar é pior que alarme ausente:
 * ninguém detecta a condição que ele deveria estar vigiando, sem nenhum
 * sinal de "o alarme está quebrado" — só o `systemd-failed-units-alarm`
 * (que mede `failed`, não a CAUSA) sinaliza algo, e só depois do 1º
 * disparo.
 *
 * Este módulo é o guard COMPLEMENTAR: varre `~/.config/systemd/user/*.service`
 * já no disco e classifica cada unit "node-based" (ExecStart cujo binário se
 * chama `node`) contra o mesmo piso. Tri-state honesto (regra do #7776,
 * mesma rodada overnight): NUNCA relata `"ok"` quando não conseguiu
 * verificar — diretório ilegível/ausente (sessão cloud, worktree isolado,
 * clone fresco — nunca tem `~/.config/systemd/user/` populado, mesma nota
 * de `systemd-unit-exit-guard.ts`), unit sem `ExecStart=` reconhecível, ou
 * binário `node` que não responde a `--version` (path quebrado, permissão)
 * viram `"cannot-verify"`, nunca `"ok"`.
 *
 * Só ARMAR (copiar unit corrigido + `daemon-reload` + `restart`) é ação
 * manual do editor (mesma convenção de todo `docs/*-setup.md` deste repo,
 * ver `systemd-unit-exit-guard.ts`) — este módulo NUNCA escreve em
 * `~/.config/systemd/user/` nem chama `systemctl`.
 *
 * @see scripts/lib/systemd-units.ts (gerador — guard de units NOVOS)
 * @see scripts/lib/check-node-version.ts (piso mínimo, MIN_NODE_MAJOR/MINOR)
 * @see scripts/lib/systemd-unit-exit-guard.ts (mesmo padrão de leitura de
 *      unit já armada, `systemdUserUnitDir()` reusado daqui)
 * @see scripts/systemd-node-floor-guard.ts (CLI read-only que consome isto)
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_NODE_MAJOR, MIN_NODE_MINOR } from "./check-node-version.ts";
import { systemdUserUnitDir } from "./systemd-unit-exit-guard.ts";

export type NodeFloorVerdict = "ok" | "below-floor" | "cannot-verify";

export interface UnitNodeFloorResult {
  unitFileName: string;
  /** Path do binário node extraído de `ExecStart=`, ou `null` se não deu pra extrair. */
  nodePath: string | null;
  /** Versão resolvida (`node --version`, formato `vMAJOR.MINOR.PATCH`), ou `null` se não deu pra resolver. */
  nodeVersion: string | null;
  verdict: NodeFloorVerdict;
  /** Presente sempre que `verdict !== "ok"` — mensagem pronta pra exibir. */
  detail?: string;
}

export type SystemdUnitsNodeFloorVerdict = "ok" | "below-floor" | "cannot-verify";

export interface SystemdUnitsNodeFloorReport {
  verdict: SystemdUnitsNodeFloorVerdict;
  /** Só as units node-based avaliadas (unit sem ExecStart=node é IGNORADA — fora do escopo deste guard). */
  units: UnitNodeFloorResult[];
  /** Presente quando `verdict !== "ok"` (nível de relatório) — resumo do que falhou. */
  detail?: string;
}

/** Extrai o path do binário do `ExecStart=` (1º token da 1ª linha que casar). Pura. */
function execStartBinaryPath(serviceContent: string): string | null {
  for (const line of serviceContent.split(/\r?\n/)) {
    const match = /^\s*ExecStart\s*=\s*(\S+)/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * `true` quando o `ExecStart=` do unit invoca um binário literalmente
 * chamado `node` (independente do path completo — `/usr/bin/node`,
 * `.../nvm/versions/node/v24.19.0/bin/node`, etc). Units que não invocam
 * node (ex: unit hand-authored rodando outro binário) estão fora do escopo
 * deste guard — não são "cannot-verify", são "não-aplicável", e o
 * scan os IGNORA silenciosamente (não entram em `units[]`).
 */
export function isNodeBasedServiceUnit(serviceContent: string): boolean {
  const path = execStartBinaryPath(serviceContent);
  if (!path) return false;
  const base = path.split("/").pop() ?? path;
  return base === "node";
}

/** Parseia `vMAJOR.MINOR.PATCH` (com ou sem `v` inicial) em `{major, minor}`. `null` se formato inesperado. */
function parseVersionParts(version: string): { major: number; minor: number } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function isAtLeastFloor(major: number, minor: number): boolean {
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

/**
 * Avalia UM unit `.service` já lido (conteúdo em string) contra o piso de
 * Node. Pura — `resolveVersion` é injetado (permite testar sem executar
 * nenhum binário real; produção usa `resolveNodeVersionForPath` abaixo).
 * Assume que o chamador já confirmou `isNodeBasedServiceUnit` (ou aceita
 * reportar `"cannot-verify"` pra um unit não-node — uso direto em teste).
 */
export function evaluateUnitNodeFloor(
  unitFileName: string,
  serviceContent: string,
  resolveVersion: (nodePath: string) => string | null,
): UnitNodeFloorResult {
  const nodePath = execStartBinaryPath(serviceContent);
  if (!nodePath) {
    return {
      unitFileName,
      nodePath: null,
      nodeVersion: null,
      verdict: "cannot-verify",
      detail: "ExecStart= ausente ou sem binário reconhecível no unit",
    };
  }

  const nodeVersion = resolveVersion(nodePath);
  if (!nodeVersion) {
    return {
      unitFileName,
      nodePath,
      nodeVersion: null,
      verdict: "cannot-verify",
      detail: `não foi possível determinar a versão do node em "${nodePath}" (binário ausente, sem permissão, ou "--version" falhou)`,
    };
  }

  const parts = parseVersionParts(nodeVersion);
  if (!parts) {
    return {
      unitFileName,
      nodePath,
      nodeVersion,
      verdict: "cannot-verify",
      detail: `formato de versão inesperado: "${nodeVersion}"`,
    };
  }

  if (isAtLeastFloor(parts.major, parts.minor)) {
    return { unitFileName, nodePath, nodeVersion, verdict: "ok" };
  }

  return {
    unitFileName,
    nodePath,
    nodeVersion,
    verdict: "below-floor",
    detail:
      `${nodeVersion} < ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 (piso do projeto — node:sqlite builtin, ver check-node-version.ts) ` +
      `— ExecStart="${nodePath}"`,
  };
}

/**
 * Resolve a versão REAL de um binário node executando `<path> --version`
 * (leitura pura, nenhuma mutação — não toca systemd nem escreve nada).
 * Qualquer falha (path inexistente, sem permissão, timeout, saída
 * inesperada) vira `null` — nunca lança, nunca "adivinha" pelo path.
 */
export function resolveNodeVersionForPath(nodePath: string): string | null {
  try {
    const out = execFileSync(nodePath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Varre `dirAbs` (default: `~/.config/systemd/user/`, mesmo path de
 * `systemdUserUnitDir()`) e classifica todo unit `.service` node-based
 * contra o piso de Node. Tri-state honesto (#7776): diretório
 * ausente/ilegível vira `verdict: "cannot-verify"` no nível do RELATÓRIO
 * (nunca "ok" por omissão — sessão cloud/worktree isolado é o caso normal
 * fora do `helios`, mas ainda assim não é "verificado limpo").
 *
 * Prioridade do veredito agregado: `"below-floor"` (qualquer unit abaixo do
 * piso) > `"cannot-verify"` (nenhum below-floor confirmado, mas pelo menos
 * 1 unit não confirmável) > `"ok"` (todas as units node-based confirmadas
 * ok, ou nenhuma unit node-based encontrada).
 */
export function scanArmedUnitsNodeFloor(
  dirAbs: string = systemdUserUnitDir(),
  resolveVersion: (nodePath: string) => string | null = resolveNodeVersionForPath,
): SystemdUnitsNodeFloorReport {
  let fileNames: string[];
  try {
    fileNames = readdirSync(dirAbs).filter((f) => f.endsWith(".service"));
  } catch (e) {
    return {
      verdict: "cannot-verify",
      units: [],
      detail: `não foi possível listar "${dirAbs}": ${(e as Error).message}`,
    };
  }

  const units: UnitNodeFloorResult[] = [];
  for (const fileName of fileNames) {
    let content: string;
    try {
      content = readFileSync(join(dirAbs, fileName), "utf8");
    } catch (e) {
      units.push({
        unitFileName: fileName,
        nodePath: null,
        nodeVersion: null,
        verdict: "cannot-verify",
        detail: `não foi possível ler o arquivo: ${(e as Error).message}`,
      });
      continue;
    }
    if (!isNodeBasedServiceUnit(content)) continue; // fora de escopo, não é finding
    units.push(evaluateUnitNodeFloor(fileName, content, resolveVersion));
  }

  const belowFloor = units.filter((u) => u.verdict === "below-floor");
  if (belowFloor.length > 0) {
    return {
      verdict: "below-floor",
      units,
      detail: `${belowFloor.length} unit(s) com ExecStart= abaixo do piso de Node — ver "comando de reparo" em scripts/systemd-node-floor-guard.ts`,
    };
  }

  const cannotVerify = units.filter((u) => u.verdict === "cannot-verify");
  if (cannotVerify.length > 0) {
    return {
      verdict: "cannot-verify",
      units,
      detail: `${cannotVerify.length} unit(s) node-based não confirmável(is)`,
    };
  }

  return { verdict: "ok", units };
}
