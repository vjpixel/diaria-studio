/**
 * scripts/lib/systemd-unit-exit-guard.ts (#6695)
 *
 * `successExitCodes` em `scripts/lib/scheduled-tasks.ts` só vira
 * comportamento REAL quando a unit `.service` correspondente, já ARMADA em
 * `~/.config/systemd/user/` no `helios`, declara `SuccessExitStatus=` pra
 * esse exit code (feature nativa do systemd, `man systemd.exec`) — ver
 * `scripts/lib/systemd-units.ts` (`buildSystemdUnitFiles`), que é quem
 * GERA esse texto a partir do registro.
 *
 * O problema que este módulo fecha (achado #6695, commit 5997cddd/#6562-
 * #6563): declarar `successExitCodes` no registro NÃO propaga sozinho pra
 * uma unit já armada em produção — `scripts/setup-systemd-timers.ts` só
 * REGENERA o texto em `.systemd-units/` (git-ignorado); copiar pra
 * `~/.config/systemd/user/` + `daemon-reload` é sempre passo MANUAL do
 * editor (ver docs/clarice-guardrail-alarm-setup.md). Sem esse passo, um
 * script que passa a sair com exit N não-zero pra sinalizar "skip
 * deliberado" (ex: `EX_TEMPFAIL`/75 em `clarice-guardrail-alarm.ts`) faz o
 * systemd marcar a unit `failed` de verdade — pior que antes da mudança de
 * exit code, e justamente o sintoma que `Diaria-Systemd-Unit-Rate-Alarm`
 * (#6455) existe pra medir.
 *
 * `isExitCodeArmedForUnit` lê a unit REAL em disco (se acessível — sessão
 * cloud/worktree isolado/clone fresco nunca tem `~/.config/systemd/user/`
 * populado, então "não encontrado" é o caminho normal fora do `helios`, não
 * um erro) e confirma que `SuccessExitStatus=` já inclui o exit code em
 * questão. Fail-soft SEMPRE na direção conservadora: qualquer situação em
 * que não dá pra confirmar a declaração (arquivo ausente, sem permissão,
 * parse vazio) retorna `false` — o caller deve então preferir exit 0 (êxito
 * incondicional, seguro em QUALQUER unit, com ou sem `SuccessExitStatus=`)
 * em vez do exit code "informativo" que depende da unit já saber tratá-lo.
 *
 * @see scripts/lib/systemd-units.ts (gera o texto que este módulo lê de volta)
 * @see scripts/clarice-guardrail-alarm.ts (1º consumidor, #6695)
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { unitBaseName } from "./systemd-units.ts";

/** Diretório onde unit files de usuário ficam armadas depois do
 * `cp .systemd-units/*.{service,timer} ~/.config/systemd/user/` manual
 * documentado em cada `docs/*-setup.md` (ver `systemctl --user` docs). */
export function systemdUserUnitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

/** Path absoluto esperado da unit `.service` ARMADA (não a gerada em
 * `.systemd-units/`) pra uma task do registro, dado o `TaskName` exato. */
export function armedServiceUnitPath(taskName: string): string {
  return join(systemdUserUnitDir(), `${unitBaseName(taskName)}.service`);
}

/**
 * Parseia o valor de `SuccessExitStatus=` (podem ser vários números
 * separados por espaço, systemd aceita múltiplas linhas cumulativas) de um
 * conteúdo de unit `.service` já lido. Pura — não toca filesystem.
 */
export function parseSuccessExitStatuses(serviceFileContent: string): number[] {
  const codes: number[] = [];
  for (const line of serviceFileContent.split(/\r?\n/)) {
    const match = /^\s*SuccessExitStatus\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    for (const token of match[1].trim().split(/\s+/)) {
      // #6695 review finding: token vazio (linha "SuccessExitStatus=" sem
      // valor, ou só espaços) faz `Number("")` retornar 0, que passaria
      // `Number.isFinite` e seria registrado como "0 declarado" mesmo sem
      // nenhum código real na linha -- `trim()` acima já reduz o caso comum
      // a string vazia, mas o guard explícito cobre qualquer token vazio
      // remanescente de espaços múltiplos.
      if (token === "") continue;
      const n = Number(token);
      if (Number.isFinite(n)) codes.push(n);
    }
  }
  return codes;
}

/**
 * `true` só quando o conteúdo da unit já declara `exitCode` em
 * `SuccessExitStatus=`. Pura — recebe o conteúdo já lido (facilita teste
 * sem tocar filesystem real).
 */
export function isSuccessExitStatusDeclared(serviceFileContent: string, exitCode: number): boolean {
  return parseSuccessExitStatuses(serviceFileContent).includes(exitCode);
}

/**
 * Checagem fim-a-fim, fail-soft: lê a unit ARMADA de `taskName` (se
 * existir nesta máquina) e confirma que `exitCode` está coberto por
 * `SuccessExitStatus=`. Qualquer situação não confirmável (arquivo
 * ausente, erro de leitura) retorna `false` — nunca lança, nunca assume
 * "armado" por omissão.
 */
export function isExitCodeArmedForUnit(taskName: string, exitCode: number): boolean {
  const path = armedServiceUnitPath(taskName);
  try {
    if (!existsSync(path)) return false;
    const content = readFileSync(path, "utf8");
    return isSuccessExitStatusDeclared(content, exitCode);
  } catch {
    return false;
  }
}
