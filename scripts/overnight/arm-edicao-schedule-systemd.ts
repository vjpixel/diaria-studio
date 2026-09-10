#!/usr/bin/env node
/**
 * scripts/overnight/arm-edicao-schedule-systemd.ts (#7036)
 *
 * Arma/desarma o timer systemd `--user` da edição diária E publica a
 * atestação cross-machine (`scripts/lib/edicao-schedule-attestation.ts`) —
 * par Linux do que `setup-edicao-schedule.ps1` já faz no Windows.
 *
 * Por que existe: `edicao-diaria-staleness-alarm.ts` só consulta o agendador
 * da máquina onde o ALARME roda. Antes deste wrapper, armar no Linux era
 * `systemctl --user enable --now` digitado à mão, que não publicava nada —
 * se o alarme rodasse em outra máquina, ele leria o `disabled` do agendador
 * local e silenciaria com a automação armada aqui (a lacuna que a PR #7860
 * deixou como TODO).
 *
 * Ordem importa: o marcador só é gravado DEPOIS de o `systemctl` sair 0.
 * `systemctl` falhou → nada é gravado e o script sai 1 (nunca afirmar
 * "armado" sem ter armado, nem "desarmado" com o timer possivelmente ainda
 * ativo). Falha só na escrita do marcador (`data/` ausente, OneDrive fora)
 * é best-effort, igual ao writer Windows: avisa alto, sai 0 — o timer já
 * mudou de estado e isso não se desfaz por causa do marcador.
 *
 * Uso:
 *   npx tsx scripts/overnight/arm-edicao-schedule-systemd.ts --arm
 *   npx tsx scripts/overnight/arm-edicao-schedule-systemd.ts --disarm
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, isMainModule } from "../lib/cli-args.ts";
import { EDICAO_UNIT_NAME } from "../lib/edicao-systemd-units.ts";
import {
  buildEdicaoScheduleAttestation,
  EDICAO_SCHEDULE_ATTESTATION_FILES,
} from "../lib/edicao-schedule-attestation.ts";

export type ArmAction = "arm" | "disarm";

/** `--arm` XOR `--disarm`; os dois ou nenhum → `null` (uso inválido). */
export function parseArmAction(argv: string[]): ArmAction | null {
  const arm = hasFlag(argv, "arm");
  const disarm = hasFlag(argv, "disarm");
  if (arm === disarm) return null;
  return arm ? "arm" : "disarm";
}

export function buildSystemctlArgs(action: ArmAction): string[] {
  return ["--user", action === "arm" ? "enable" : "disable", "--now", `${EDICAO_UNIT_NAME}.timer`];
}

export interface ArmDeps {
  runSystemctl: (args: string[]) => { status: number | null; stderr: string };
  dataDirExists: (dir: string) => boolean;
  writeFile: (path: string, content: string) => void;
  machine: string;
  now: Date;
}

export interface ArmResult {
  /** `false` só quando o `systemctl` falhou — o timer não mudou de estado. */
  ok: boolean;
  attestationPath: string;
  attestationWritten: boolean;
  message: string;
}

export function armEdicaoScheduleSystemd(action: ArmAction, dataDir: string, deps: ArmDeps): ArmResult {
  const attestationPath = join(dataDir, EDICAO_SCHEDULE_ATTESTATION_FILES.systemd);
  const args = buildSystemctlArgs(action);
  const run = deps.runSystemctl(args);
  if (run.status !== 0) {
    return {
      ok: false,
      attestationPath,
      attestationWritten: false,
      message: `systemctl ${args.join(" ")} falhou (exit ${run.status}): ${run.stderr.trim()} — atestação NÃO gravada, estado do timer inalterado.`,
    };
  }
  if (!deps.dataDirExists(dataDir)) {
    return {
      ok: true,
      attestationPath,
      attestationWritten: false,
      message: `timer ${action === "arm" ? "armado" : "desarmado"}, mas '${dataDir}' não existe nesta máquina — atestação cross-machine NÃO gravada (ver CLAUDE.md § Setup, data/ via OneDrive).`,
    };
  }
  // Fora do try de propósito: é função pura — se lançar, é bug de código e
  // deve estourar alto, não virar "falha de escrita best-effort".
  const attestation = buildEdicaoScheduleAttestation(deps.machine, "systemd", action === "arm", deps.now);
  try {
    deps.writeFile(attestationPath, JSON.stringify(attestation));
  } catch (e) {
    return {
      ok: true,
      attestationPath,
      attestationWritten: false,
      message: `timer ${action === "arm" ? "armado" : "desarmado"}, mas falhou gravar a atestação em ${attestationPath}: ${(e as Error).message}`,
    };
  }
  return {
    ok: true,
    attestationPath,
    attestationWritten: true,
    message: `timer ${action === "arm" ? "armado" : "desarmado"}; atestação gravada em ${attestationPath} (armed=${action === "arm"}).`,
  };
}

function main(): void {
  const action = parseArmAction(process.argv.slice(2));
  if (!action) {
    console.error("Uso: arm-edicao-schedule-systemd.ts --arm | --disarm");
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const result = armEdicaoScheduleSystemd(action, join(root, "data"), {
    runSystemctl: (args) => {
      const r = spawnSync("systemctl", args, { encoding: "utf8" });
      return { status: r.status, stderr: r.error ? r.error.message : (r.stderr ?? "") };
    },
    dataDirExists: existsSync,
    writeFile: (path, content) => writeFileSync(path, content, "utf8"),
    machine: hostname(),
    now: new Date(),
  });
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  if (result.attestationWritten) console.log(result.message);
  else console.warn(`AVISO: ${result.message}`);
}

if (isMainModule(import.meta.url)) main();
