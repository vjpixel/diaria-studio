/**
 * vertical-download-guard.ts (#11432) — guard compartilhado pelos dois timers
 * do 300 que baixam o MESMO vertical do Drive (`diaria-comentada-{AAMMDD}-short.mp4`):
 * `shorts-linkedin-profile-timer.ts` (#10982) e `shorts-threads-profile-timer.ts`
 * (#11410). Antes do #11432 só o do Threads recuava; o do LinkedIn rodava
 * `publish-shorts --from-drive` por cima de um download em curso e truncava o
 * `.part` do outro, que subia pro R2 um arquivo corrompido.
 *
 * Os nomes dos locks moram aqui (e não em cada timer) porque cada timer precisa
 * conhecer o lock do OUTRO — importar um timer do outro nos dois sentidos seria
 * import circular. Os timers re-exportam com os nomes de sempre.
 *
 * Este é o recuo educado (exit 0, tenta na próxima hora). A garantia de verdade
 * é o `O_EXCL` no `.part` em `scripts/lib/drive-download.ts`: mesmo que os dois
 * passem por aqui juntos, só um baixa.
 */

export const SHORTS_LINKEDIN_TIMER_LOCK_FILE = "_internal/.shorts-linkedin-timer.lock";
export const SHORTS_THREADS_TIMER_LOCK_FILE = "_internal/.shorts-threads-timer.lock";
/** Lock com mais que isto é resto de processo morto (vale pros dois timers). */
export const SHORTS_TIMER_LOCK_STALE_MS = 90 * 60_000;
/** `.part` mais novo que isto = outro processo baixando o vertical agora. */
export const DOWNLOAD_PART_FRESH_MS = 30 * 60_000;

/**
 * Exit do `publish-shorts.ts --from-drive` quando o Drive devolveu o arquivo
 * vazio (`DriveDownloadEmptyError`, #13540/#13541): o upload do editor criou o
 * arquivo e o conteúdo ainda não chegou. 75 = EX_TEMPFAIL do sysexits.
 */
export const PUBLISH_SHORTS_DRIVE_NOT_READY_EXIT = 75;

/**
 * Até quanto depois do horário do vertical o download vazio é espera, não
 * alarme. Mesma 1 h do `missing-video`: o upload que segue vazio na execução
 * seguinte (a de hora em hora) já não é "subindo agora", e o editor é avisado.
 */
export const DRIVE_NOT_READY_GRACE_MS = 60 * 60_000;

/**
 * Puro (#13540/#13541): a saída do `publish-shorts` é o download vazio de um
 * vertical que ainda está subindo, dentro da tolerância? Devolve o motivo da
 * espera (o timer sai 0 e tenta na próxima hora), ou null (segue o alarme de
 * sempre). Só o exit dedicado SEM JSON no stdout conta: qualquer outra saída é
 * lida pelo intérprete do timer como antes.
 */
export function driveNotReadyWait(input: { exitCode: number | null; stdout: string; nowMs: number; at: string }): string | null {
  if (input.exitCode !== PUBLISH_SHORTS_DRIVE_NOT_READY_EXIT || input.stdout.trim() !== "") return null;
  const atMs = Date.parse(input.at);
  if (!Number.isFinite(atMs) || input.nowMs - atMs >= DRIVE_NOT_READY_GRACE_MS) return null;
  return "o Drive devolveu o vertical vazio (o upload ainda está em curso)";
}

/**
 * Puro: outro processo está baixando o vertical agora? `.part` recente do
 * download (`downloadDriveFile` grava em `{arquivo}.part`), ou o lock de pé do
 * timer da OUTRA rede, que baixa o mesmo arquivo. Devolve o motivo, ou null.
 */
export function verticalDownloadBusy(input: {
  partMtimeMs: number | null;
  otherLockMtimeMs: number | null;
  /** Ex.: "LinkedIn" — entra no motivo. */
  otherLabel: string;
  otherLockFile: string;
  nowMs: number;
}): string | null {
  if (input.partMtimeMs !== null && input.nowMs - input.partMtimeMs <= DOWNLOAD_PART_FRESH_MS) return "download do vertical em curso (.part recente)";
  if (input.otherLockMtimeMs !== null && input.nowMs - input.otherLockMtimeMs <= SHORTS_TIMER_LOCK_STALE_MS) {
    return `o timer do ${input.otherLabel} está no meio de uma execução (${input.otherLockFile}) e pode estar baixando o vertical`;
  }
  return null;
}
