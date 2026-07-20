/**
 * drive-constants.ts — endpoints da Google Drive API v3.
 *
 * Usado por `drive-sync.ts` pra evitar duplicação de string literals
 * (#1308 item 1). Também era usado por `sync-report.ts`/`upload-report-to-drive.ts`
 * (removidos em #3713 — mecanismo de relatórios no Drive descontinuado).
 */

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

/**
 * Nome atual da pasta raiz do projeto no Drive (dentro de `Work/Startups/`).
 * Renomeada de "diar.ia" para "diar.ia.br" em 2026-07-16 (#3573) — os
 * lookups que tinham o nome antigo hardcoded quebravam silenciosamente
 * (fail-soft) todo sync de edição + upload/sync de reports.
 *
 * Único ponto a editar na próxima vez que a pasta for renomeada. Usar em
 * conjunto com `DRIVE_ROOT_FOLDER_NAME_FALLBACKS` via
 * `driveFindFolderByNames` (lib/drive-helpers.ts) em vez de
 * `driveFindFolderInParent` direto, pra tolerar rename/rollback sem
 * repetir o incidente.
 */
export const DRIVE_ROOT_FOLDER_NAME = "diar.ia.br";

/**
 * Nomes legados da pasta raiz, aceitos como fallback (mais recente
 * primeiro) caso `DRIVE_ROOT_FOLDER_NAME` não seja encontrado — cobre
 * rollback do rename #3573 e evita repetir o incidente na próxima mudança
 * de nome (o próximo rename só precisa: trocar `DRIVE_ROOT_FOLDER_NAME` pro
 * nome novo e adicionar o nome anterior aqui).
 */
export const DRIVE_ROOT_FOLDER_NAME_FALLBACKS = ["diar.ia"];
