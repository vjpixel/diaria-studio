/**
 * scripts/lib/systemd-node-binary-checked.ts (#13151)
 *
 * Resolve o node do `ExecStart=` (`resolveSystemdNodeBinary`, #13136) e
 * confere o binário escolhido: `--version` responde e está no piso do
 * projeto. É a mesma sequência que `scripts/setup-systemd-timers.ts` roda no
 * `main`, aqui num ponto só para os geradores fora do registry
 * (`setup-edicao-schedule-systemd.ts`, `setup-watchdog-schedule-systemd.ts`)
 * e para o alarme de units defasadas (`systemd-units-drift-alarm.ts`, #13152).
 *
 * Fica fora de `systemd-node-binary.ts` porque `resolveNodeVersionForPath`
 * roda `node --version` (child_process) e aquele módulo é puro.
 */
import { assertSupportedNodeVersion } from "./check-node-version.ts";
import { resolveSystemdNodeBinary, type SystemdNodeBinary } from "./systemd-node-binary.ts";
import { resolveNodeVersionForPath } from "./systemd-node-floor-guard.ts";

/** Dependências injetáveis (teste). Produção usa os defaults. */
export interface CheckedNodeBinaryDeps {
  resolveNodeBinary?: (override: string | undefined) => SystemdNodeBinary;
  resolveVersion?: (nodePath: string) => string | null;
}

export interface CheckedSystemdNodeBinary extends SystemdNodeBinary {
  /** Saída de `<path> --version`, ex. `v24.19.0`. */
  version: string;
}

/**
 * Lança com mensagem acionável quando nenhum node casa com o `.nvmrc`, o
 * binário não responde a `--version` ou está abaixo do piso. Nunca devolve
 * um node não conferido.
 */
export function resolveCheckedSystemdNodeBinary(
  override: string | undefined,
  deps: CheckedNodeBinaryDeps = {},
): CheckedSystemdNodeBinary {
  const bin = (deps.resolveNodeBinary ?? ((o) => resolveSystemdNodeBinary({ override: o })))(override);
  const version = (deps.resolveVersion ?? resolveNodeVersionForPath)(bin.path);
  if (!version) throw new Error(`"${bin.path} --version" não respondeu — node do ExecStart inválido (#13136)`);
  assertSupportedNodeVersion(version);
  return { ...bin, version };
}
