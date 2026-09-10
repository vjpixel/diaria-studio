/**
 * scripts/lib/edicao-schedule-attestation.ts (#7036)
 *
 * Marcador cross-machine que ataca a lacuna documentada em
 * `TIMER_DISABLED_CROSS_MACHINE_CAVEAT` (`edicao-diaria-staleness-alarm.ts`,
 * #6898): `queryTaskArmed("Diaria-Edicao-Diaria")` só enxerga o agendador da
 * máquina em que O ALARME roda (hoje: `helios`/Linux). Enquanto nada está
 * agendado em máquina nenhuma (decisão do editor, 19/08/2026) isso é
 * suficiente — mas se a via Windows for reativada no futuro SEM o par
 * Linux (`.service`/`.timer`) também ser reativado, o alarme continuaria
 * lendo `disabled` no `helios` e silenciando pra sempre, mesmo com a
 * edição falhando em silêncio no Windows. Mesma classe de regressão do
 * #5563 (silêncio que não avisa).
 *
 * Desenho (mesmo padrão do canário de `onedrive-sync-alarm.ts`, #5548):
 * um arquivo em `data/` (junction/symlink do OneDrive, já sincronizado
 * entre as máquinas do editor — ver CLAUDE.md § Setup) que a máquina que
 * de fato ARMA/DESARMA a task publica com seu próprio estado. O alarme lê
 * esse marcador em vez de perguntar só ao agendador local — `data/overnight-schedule.log`
 * já é precedente de arquivo compartilhado lido sem se importar com qual
 * runner gravou.
 *
 * **Quem escreve hoje — só o lado Windows, e só parcialmente (TODO):**
 * `scripts/overnight/setup-edicao-schedule.ps1` é o único ponto do repo
 * que de fato chama o verbo de armar/desarmar (`Register-ScheduledTask`/
 * `Unregister-ScheduledTask`) — por isso ele grava este marcador ao rodar
 * (best-effort, nunca bloqueia o registro da task se a escrita falhar). O
 * lado Linux (`scripts/overnight/setup-edicao-schedule-systemd.ts`) SÓ
 * GERA os arquivos `.service`/`.timer` em disco — armar de verdade é
 * `systemctl --user enable --now`, digitado à mão pelo editor fora de
 * qualquer script deste repo (ver docstring de aquele arquivo). Não há
 * hoje um hook centralizado que saiba "acabei de armar/desarmar" do lado
 * Linux para escrever este marcador — **TODO**: se/quando um wrapper de
 * armamento Linux for criado (ex: `scripts/overnight/arm-edicao-schedule-systemd.sh`
 * que roda o `systemctl --user enable --now` E grava o marcador), ele deve
 * escrever aqui com `scheduler: "systemd"`. Até lá, a leitura é
 * necessariamente BEST-EFFORT: marcador ausente é tratado como "sem
 * informação cross-machine", nunca como "desarmado em algum lugar" — vide
 * `resolveEdicaoTimerStateCrossMachine`.
 *
 * @see scripts/lib/edicao-diaria-staleness-alarm.ts (consumidor — combina com `EdicaoTimerState` local)
 * @see scripts/lib/onedrive-sync-alarm.ts (mesmo padrão de canário cross-machine)
 * @see scripts/lib/machine-id.ts (identidade de máquina — mesmo sinal, `os.hostname()`)
 * @see scripts/overnight/setup-edicao-schedule.ps1 (único writer hoje)
 */

export type EdicaoScheduleScheduler = "windows-task-scheduler" | "systemd";

export interface EdicaoScheduleAttestation {
  /** `os.hostname()` (ou `$env:COMPUTERNAME` do lado PowerShell) da máquina
   * que gravou — só informativo/auditoria, não usado na decisão pura hoje
   * (nenhuma comparação "é esta máquina?" — ver docstring de
   * `resolveEdicaoTimerStateCrossMachine` pro porquê). */
  machine: string;
  scheduler: EdicaoScheduleScheduler;
  /** `true` = esta máquina tem a task `Diaria-Edicao-Diaria` armada
   * (registrada + habilitada) no momento em que escreveu. `false` = esta
   * máquina acabou de DESARMAR (unregister/disable) — não confundir com
   * "nunca escreveu" (ausência de arquivo, tratada à parte). */
  armed: boolean;
  /** ISO timestamp de quando esta máquina escreveu por último. */
  updatedAt: string;
}

export function buildEdicaoScheduleAttestation(
  machine: string,
  scheduler: EdicaoScheduleScheduler,
  armed: boolean,
  now: Date,
): EdicaoScheduleAttestation {
  return { machine, scheduler, armed, updatedAt: now.toISOString() };
}

/**
 * Pure — parseia o conteúdo bruto (já lido pelo caller via `readFileSync`,
 * ou `null` se o arquivo nunca existiu) do marcador. Fail-soft: JSON
 * corrompido, campo ausente, ou tipo errado → `null`, o MESMO resultado de
 * "arquivo nunca existiu" — o caller (`resolveEdicaoTimerStateCrossMachine`)
 * trata as duas coisas de forma idêntica, nunca inventa um veredito a
 * partir de um marcador ilegível.
 */
export function parseEdicaoScheduleAttestation(raw: string | null): EdicaoScheduleAttestation | null {
  if (raw === null) return null;
  try {
    const obj: unknown = JSON.parse(raw);
    if (
      obj !== null &&
      typeof obj === "object" &&
      typeof (obj as Record<string, unknown>).machine === "string" &&
      ((obj as Record<string, unknown>).scheduler === "windows-task-scheduler" ||
        (obj as Record<string, unknown>).scheduler === "systemd") &&
      typeof (obj as Record<string, unknown>).armed === "boolean" &&
      typeof (obj as Record<string, unknown>).updatedAt === "string"
    ) {
      return obj as EdicaoScheduleAttestation;
    }
    return null;
  } catch {
    return null;
  }
}

/** Além disso um marcador é tratado como STALE — generoso o bastante pra
 * nunca invalidar um estado real (armar/desarmar é ação manual rara, não
 * uma task diária), mas finito pra um marcador de anos atrás não ditar a
 * decisão pra sempre caso a máquina que o escreveu suma sem desarmar. */
export const ATTESTATION_STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 dias

export function isAttestationStale(attestation: EdicaoScheduleAttestation, now: Date): boolean {
  const writtenMs = Date.parse(attestation.updatedAt);
  if (Number.isNaN(writtenMs)) return true; // timestamp ilegível — sem confiança, trata como stale
  return now.getTime() - writtenMs > ATTESTATION_STALE_MS;
}

/**
 * Pure — combina o estado LOCAL (`queryTaskArmed` traduzido pro caller —
 * `"armed" | "disabled" | "unknown"`, mesmo domínio de `EdicaoTimerState`
 * em `edicao-diaria-staleness-alarm.ts`, não importado aqui de propósito
 * pra evitar import circular) com a atestação cross-machine.
 *
 * Regra central: a atestação só pode FORTALECER o sinal de "armado em
 * algum lugar" — nunca enfraquecê-lo. Se `attestation.armed === true` (e
 * não stale), o resultado é sempre `"armed"`, mesmo que a consulta LOCAL
 * desta máquina diga `"disabled"` — é exatamente o cenário do #7036: a via
 * Windows reativada sem o par Linux ser reativado faria o `helios`
 * consultar seu PRÓPRIO systemd, ver `disabled`, e sem esta atestação
 * silenciar um alarme que deveria disparar porque a automação está de
 * fato armada (na outra máquina).
 *
 * Atestação ausente, corrompida, ou stale → tratada como "sem informação
 * cross-machine", preserva o comportamento LOCAL de hoje (pré-#7036) —
 * fail-soft: nunca inventa "desarmado em algum lugar" a partir da
 * ausência do marcador (o único writer hoje é o lado Windows, então
 * ausência é o caso comum enquanto o TODO do lado Linux não for
 * implementado).
 */
export function resolveEdicaoTimerStateCrossMachine(
  local: "armed" | "disabled" | "unknown",
  attestation: EdicaoScheduleAttestation | null,
  now: Date,
): "armed" | "disabled" | "unknown" {
  if (attestation === null) return local;
  if (isAttestationStale(attestation, now)) return local;
  if (attestation.armed) return "armed";
  return local;
}
