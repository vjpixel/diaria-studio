/**
 * drive-sync.ts
 *
 * Sincroniza arquivos de edição entre `data/editions/{YYMMDD}/` e
 * `Work/Startups/diar.ia/edicoes/{YYMM}/{YYMMDD}/` no Google Drive.
 *
 * Substitui o subagente `drive-syncer` (Haiku via Task).
 *
 * Uso:
 *   npx tsx scripts/drive-sync.ts \
 *     --mode push|pull \
 *     --edition-dir data/editions/260418/ \
 *     --stage 1 \
 *     --files 01-categorized.md,02-reviewed.md
 *
 * Output (stdout): JSON com { mode, stage, edition, uploaded[], pulled[], warnings[] }
 * Se `--files` for vazio ou não passado, sai com { skipped: true }.
 *
 * Health check (#121):
 *   npx tsx scripts/drive-sync.ts --health-check
 *
 * Roda 1 chamada de listagem mínima pra validar OAuth. Output:
 *   { ok: true, latency_ms: N }       # exit 0
 *   { ok: false, error: ..., ... }    # exit 2 (token expirado/auth falha)
 *
 * Cache: data/drive-cache.json (estrutura documentada em .claude/agents/drive-syncer.md)
 * Credenciais: data/.credentials.json (gerado por scripts/oauth-setup.ts)
 *
 * #2833: o cliente Drive de baixo nível (upload/download/cache/3-way-merge/
 * archive/folder-resolution) foi extraído pra scripts/lib/drive-sync-core.ts
 * — movimentação pura, re-exportado abaixo pra manter compat com
 * importadores existentes. Este arquivo mantém a orquestração push/pull e o CLI.
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { resolve, extname, basename as pathBasename } from "node:path";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts"; // #535
import { DRIVE_API } from "./lib/drive-constants.ts"; // #1308 item 1
import {
  gFetchRetry,
  driveList,
  escapeDriveQueryString,
} from "./lib/drive-helpers.ts"; // #1308 itens 2, 4
import { logEvent } from "./lib/run-log.ts"; // #612
import { unescapeMarkdown } from "./lib/markdown-unescape.ts"; // #1188
import type { DriveCache, FileEntry, EditionCache } from "./lib/schemas/drive-cache.ts";
// #2833: extraído pra scripts/lib/drive-sync-core.ts (movimentação pura) —
// re-exportado abaixo pra manter compat com importadores existentes.
import {
  ROOT,
  CACHE_PATH,
  classifyOAuthError,
  OAUTH_EXPIRED_ALERT,
  type SyncResult,
  CONVERT_TO_DOC,
  GOOGLE_DOC_MIME,
  loadConflictToleranceSeconds,
  CONFLICT_TOLERANCE_SECONDS,
  driveGetMetadata,
  mimeTypeFor,
  getFileBytes,
  driveUploadFile,
  driveUpdateFile,
  driveDownloadFile,
  snapshotPath,
  attemptThreeWayMerge,
  savePrePushSnapshot,
  loadPrePushSnapshot,
  MAX_ARCHIVES_PER_FILE,
  listVersionArchives,
  cleanupOldArchives,
  driveCopyFile,
  driveExportFile,
  loadCache,
  saveCache,
  resolveEdicoesFolder,
  splitFilePath,
  resolveSubfolder,
  resolveDayFolder,
} from "./lib/drive-sync-core.ts";

export {
  classifyOAuthError,
  OAUTH_EXPIRED_ALERT,
  CONVERT_TO_DOC,
  GOOGLE_DOC_MIME,
  loadConflictToleranceSeconds,
  snapshotPath,
  attemptThreeWayMerge,
  savePrePushSnapshot,
  loadPrePushSnapshot,
  MAX_ARCHIVES_PER_FILE,
  listVersionArchives,
  driveCopyFile,
  splitFilePath,
  resolveSubfolder,
};
export type { SyncResult };
// Re-export types imported from schema so test imports remain unchanged
export type { DriveCache, FileEntry, EditionCache };

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export type ConflictMode = "warn" | "pull-merge" | "force";

export interface PushFileOpts {
  /** #963: comportamento em caso de CONFLICT (Drive modified após último push).
   * - "warn" (default): aborta com warning (compat com behavior original)
   * - "pull-merge": tenta 3-way merge via git merge-file --diff3
   * - "force": sobrescreve sem checagem (perigoso)
   */
  onConflict?: ConflictMode;
}

export async function pushFile(
  editionDir: string,
  filename: string,
  yymmdd: string,
  dayFolderId: string,
  cache: DriveCache,
  result: SyncResult,
  opts: PushFileOpts = {},
): Promise<void> {
  const edCache = cache.editions[yymmdd];
  const fileCache = edCache.files[filename];
  const pushCount = fileCache?.push_count ?? 0;

  // #253: filename pode incluir subpath (ex: `_internal/02-clauce-diff.md`).
  // Antes ia direto como nome do arquivo no dayFolder com `/` literal — Drive
  // aceita mas vira poluição visual na pasta do dia. Agora resolve subpath em
  // subpasta real, e usa só o basename como nome do arquivo no Drive.
  const { subpath, basename } = splitFilePath(filename);

  // #280: detectar migração de legacy slash-literal → subpasta real.
  // Se cache tem drive_file_id (arquivo antigo com nome literal `_internal/foo.md`)
  // E agora há subpath (nova convenção de subpasta), o archive do arquivo antigo
  // vai pra posição errada — logar warn pra editor limpar o órfão no Drive.
  if (subpath && pushCount > 0 && fileCache?.drive_file_id) {
    const edCache = cache.editions[yymmdd];
    const hasSubfolderEntry = edCache?.subfolder_ids?.[subpath];
    if (!hasSubfolderEntry) {
      result.warnings.push({
        file: filename,
        error_message: `migração legacy: arquivo '${filename}' tinha drive_file_id no cache mas sem subpasta '${subpath}' registrada — arquivo antigo com '/' literal no nome pode existir na pasta do dia. Limpar manualmente no Drive se necessário.`,
      });
    }
  }

  const targetParentId = subpath
    ? await resolveSubfolder(cache, yymmdd, dayFolderId, subpath)
    : dayFolderId;

  // #496: verificar se Drive foi modificado externamente após último push
  // #605: tolerância pra auto-conversão Google Doc (bumpa modifiedTime ~1-2s
  //       sem edit humano). Default 10s; override em platform.config.json
  //       (drive_sync_conflict_tolerance_seconds).
  // #963: quando opts.onConflict === "pull-merge", tenta 3-way merge antes de abortar.
  if (fileCache?.drive_file_id && fileCache?.drive_modifiedTime) {
    const meta = await driveGetMetadata(fileCache.drive_file_id);
    const cachedMs = new Date(fileCache.drive_modifiedTime).getTime();
    const driveMs = new Date(meta.modifiedTime).getTime();
    const diffSec = (driveMs - cachedMs) / 1000;
    const toleranceSec = CONFLICT_TOLERANCE_SECONDS;
    if (diffSec > toleranceSec) {
      // Conflito detectado — comportamento varia por --on-conflict:
      //   - "pull-merge" (#963): tenta 3-way merge via git merge-file --diff3
      //   - "warn" (default, compat): aborta push com warning (comportamento original)
      //   - "force": pula check, sobrescreve Drive sem 3-way (perigoso)
      const ext = extname(filename).toLowerCase();
      const isMergeable = ext === ".md" || ext === ".txt" || ext === ".json";
      if (opts.onConflict === "pull-merge" && isMergeable) {
        const baseSnapshot = loadPrePushSnapshot(editionDir, filename);
        if (!baseSnapshot) {
          result.warnings.push({
            file: filename,
            error_message: `CONFLICT: ${filename} foi modificado no Drive mas não há snapshot pre-push pra 3-way merge. Push abortado — fazer pull manual primeiro. (Próximo push terá snapshot disponível.)`,
          });
          return;
        }
        // Pull current Drive content + read local content
        let driveContent: string;
        try {
          const driveBuf = await driveDownloadFile(fileCache.drive_file_id);
          driveContent = driveBuf.toString("utf8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.warnings.push({
            file: filename,
            error_message: `CONFLICT: ${filename} pull pra 3-way merge falhou (${msg}). Push abortado.`,
          });
          return;
        }
        const localPath = resolve(ROOT, editionDir, filename);
        const localContent = readFileSync(localPath, "utf8");
        const merge = attemptThreeWayMerge(localContent, baseSnapshot, driveContent);
        if (merge.hasConflicts) {
          // Conflito de mesma região — escreve resultado com markers no local +
          // halt. Editor resolve manualmente, depois re-roda pipeline.
          writeFileSync(localPath, merge.merged, "utf8");
          result.warnings.push({
            file: filename,
            error_message: `CONFLICT: ${filename} 3-way merge tem ${merge.conflictCount} conflito(s) na mesma região. Markers <<<<<<< escritos em ${localPath}. Editor: resolver conflitos manualmente e re-rodar drive-sync (push).`,
          });
          return;
        }
        // Clean merge: substituir local pelo merged + atualizar mtime + seguir push.
        writeFileSync(localPath, merge.merged, "utf8");
        // Snapshot atualizado já reflete o merged na próxima iteração — saved no fim do push.
      } else if (opts.onConflict === "force") {
        // Sobrescreve sem 3-way. Documenta no warning pra trail editorial saber que aconteceu.
        result.warnings.push({
          file: filename,
          error_message: `FORCE_OVERWRITE: ${filename} Drive modificado externamente (${meta.modifiedTime}) mas --on-conflict=force passou — sobrescrevendo.`,
        });
      } else {
        result.warnings.push({
          file: filename,
          error_message: `CONFLICT: ${filename} foi modificado no Drive (${meta.modifiedTime}) após o último push (${fileCache.drive_modifiedTime}). Push abortado — fazer pull primeiro para não sobrescrever edições do editor.`,
        });
        return; // não sobrescrever
      }
    }
    if (diffSec > 0 && diffSec <= toleranceSec) {
      // Dentro da tolerância — auto-conversion noise. Atualiza cache silenciosamente.
      fileCache.drive_modifiedTime = meta.modifiedTime;
    }
  }

  const ext = extname(basename);
  const base = basename.slice(0, basename.length - ext.length);
  // CONVERT_TO_DOC contém só basenames (top-level files do dia). Subpasta
  // raramente vai conter MD que vira Doc, mas a lookup por basename é
  // consistente com o modelo "Doc é editorial, Tools/_internal é raw".
  const convertToDoc = CONVERT_TO_DOC.has(basename);
  // Docs nativos não precisam de extensão — Drive trata extension como cosmético.
  // Pra arquivos convertidos, tiramos `.md` do título pra ficar consistente com
  // o modelo "arquivo sem extensão = Doc".
  //
  // Estratégia (#37): o nome canônico (sem `.vN`) sempre aponta para a versão
  // mais recente. Versões anteriores ficam arquivadas como `.vN`. Editor abre o
  // arquivo canônico no Drive sem ter que procurar o maior N.
  const canonicalTitle = convertToDoc ? base : basename;
  const archiveTitle = convertToDoc
    ? `${base}.v${pushCount}`
    : `${base}.v${pushCount}${ext}`;
  const mimeType = mimeTypeFor(basename);

  const bytes = await getFileBytes(editionDir, filename);

  // Se arquivo já existe no Drive (cache tem drive_file_id válido), atualizar
  // in-place (#333) em vez de criar novo. Evita .vN orphans na pasta do editor.
  // #998: ANTES do PATCH, copiar versão atual pra `.vN` (strategy #37 — versionamento).
  // Editor pode comparar histórico no Drive sem perder edições anteriores.
  if (pushCount > 0 && fileCache?.drive_file_id) {
    // #998: archive current → .vN antes de overwrite. Best-effort: falha não bloqueia.
    try {
      const archiveResult = await driveCopyFile(
        fileCache.drive_file_id,
        archiveTitle,
        targetParentId,
      );
      console.error(
        `[drive-sync] archived previous version: ${canonicalTitle} → ${archiveTitle} (${archiveResult.id})`,
      );
    } catch (archiveErr) {
      const msg = archiveErr instanceof Error ? archiveErr.message : String(archiveErr);
      // #2318: re-throw auth-expired so the outer per-file catch routes to the
      // single dedup alert instead of emitting a misleading archive_failed warning.
      if (classifyOAuthError(msg) === "invalid_grant") throw archiveErr;
      result.warnings.push({
        file: filename,
        error_message: `archive_failed (#998): ${msg} — continuando com PATCH in-place (sem versão histórica)`,
      });
    }
    // #998: cleanup arquivos antigos (manter últimas MAX_ARCHIVES versões).
    try {
      await cleanupOldArchives(base, ext, convertToDoc, targetParentId, result, filename);
    } catch (cleanupErr) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      // #2318: re-throw auth-expired so outer catch routes to the single dedup alert.
      if (classifyOAuthError(msg) === "invalid_grant") throw cleanupErr;
      result.warnings.push({
        file: filename,
        error_message: `archive_cleanup_failed (#998): ${msg}`,
      });
    }
    try {
      const { id: driveFileId, modifiedTime, mimeType: driveMimeType } = await driveUpdateFile(
        fileCache.drive_file_id,
        bytes,
        mimeType,
        convertToDoc,
      );
      const localPath = resolve(ROOT, editionDir, filename);
      const localMtime = statSync(localPath).mtimeMs;
      edCache.files[filename] = {
        drive_file_id: driveFileId,
        drive_modifiedTime: modifiedTime,
        last_pushed_mtime: localMtime,
        push_count: pushCount + 1,
        drive_mimeType: driveMimeType,
      };
      result.uploaded.push({ file: filename, drive_file_id: driveFileId, title_used: canonicalTitle + " (updated in-place)" });
      // #963: snapshot pre-push pra próxima detecção de conflito usar como base 3-way.
      savePrePushSnapshot(editionDir, filename, bytes);
      return;
    } catch (updateErr) {
      const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      // #2318: re-throw auth-expired so outer catch routes to the single dedup alert
      // instead of a misleading update_in_place_failed warning.
      if (classifyOAuthError(msg) === "invalid_grant") throw updateErr;
      // Fallback: arquivo pode ter sido deletado no Drive — criar novo normalmente
      result.warnings.push({
        file: filename,
        error_message: `update_in_place_failed: ${canonicalTitle} (${msg}) — criando novo arquivo`,
      });
    }
  }

  // Antes de criar novo arquivo, buscar por nome na pasta destino para evitar
  // duplicatas (#362 #370). Isso acontece quando o cache está divergente (ID
  // inválido, arquivo movido, cache corrompido) e o update in-place falhou.
  const searchQ = `name='${escapeDriveQueryString(canonicalTitle)}' and '${targetParentId}' in parents and trashed=false`;
  const searchRes = await gFetchRetry(
    `${DRIVE_API}/files?q=${encodeURIComponent(searchQ)}&fields=files(id,name,modifiedTime)`,
    { headers: { "Content-Type": "application/json" } }
  );
  const searchData = (await searchRes.json()) as { files?: Array<{ id: string; name: string; modifiedTime: string }> };
  const existingFiles = searchData.files ?? [];
  if (existingFiles.length > 0) {
    console.error(
      `[drive-sync] WARN: encontrou ${existingFiles.length} arquivo(s) com mesmo nome '${canonicalTitle}' — apagou antes de criar novo (cache divergente).`
    );
    for (const existing of existingFiles) {
      console.error(`[drive-sync] Apagando duplicata anterior: ${existing.name} (${existing.id})`);
      await gFetchRetry(`${DRIVE_API}/files/${existing.id}`, { method: "DELETE" });
    }
  }

  const { id: driveFileId, modifiedTime, mimeType: driveMimeType } = await driveUploadFile(
    canonicalTitle,
    bytes,
    mimeType,
    targetParentId,
    convertToDoc
  );

  const localPath = resolve(ROOT, editionDir, filename);
  const localMtime = statSync(localPath).mtimeMs;

  edCache.files[filename] = {
    drive_file_id: driveFileId,
    drive_modifiedTime: modifiedTime,
    last_pushed_mtime: localMtime,
    push_count: pushCount + 1,
    drive_mimeType: driveMimeType,
  };

  result.uploaded.push({ file: filename, drive_file_id: driveFileId, title_used: canonicalTitle });
  // #963: snapshot pre-push pra próxima detecção de conflito usar como base 3-way.
  savePrePushSnapshot(editionDir, filename, bytes);
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/**
 * #1828: o local tem mudanças NÃO-sincronizadas (foi modificado após o último
 * push/pull registrado no cache)? Usado pra impedir que um pull sobrescreva
 * trabalho local fresco com a versão do Drive — footgun real em 260604: um pull
 * de comparação clobberou o `03-social.md` regenerado local (destaques novos)
 * com a versão velha do Drive. Sem baseline (`lastPushedMtimeMs` ausente) →
 * false (não dá pra afirmar; deixa o pull normal seguir, default seguro).
 */
export function localHasUnsyncedChanges(
  localMtimeMs: number,
  lastPushedMtimeMs: number | undefined,
  toleranceMs = 2000,
): boolean {
  if (lastPushedMtimeMs == null) return false;
  return localMtimeMs > lastPushedMtimeMs + toleranceMs;
}

export async function pullFile(
  editionDir: string,
  filename: string,
  yymmdd: string,
  cache: DriveCache,
  result: SyncResult,
  opts: { forceOverwriteLocal?: boolean } = {},
): Promise<void> {
  const fileCache = cache.editions[yymmdd]?.files?.[filename];
  if (!fileCache?.drive_file_id) return; // nunca foi subido → pular sem erro

  const meta = await driveGetMetadata(fileCache.drive_file_id);
  const driveModified = meta.modifiedTime;

  // No-op se não mudou no Drive
  if (driveModified <= fileCache.drive_modifiedTime) return;

  // #1828: guard de frescor — NÃO sobrescrever um local que tem mudanças não
  // sincronizadas (modificado após o último sync). Senão um pull rotineiro/de
  // comparação clobbera trabalho fresco (ex: social regenerado pós-troca de
  // destaques). `--force-overwrite-local` ignora o guard quando o editor quer
  // mesmo a versão do Drive.
  const localPath = resolve(ROOT, editionDir, filename);
  if (!opts.forceOverwriteLocal && existsSync(localPath)) {
    const localMtime = statSync(localPath).mtimeMs;
    if (localHasUnsyncedChanges(localMtime, fileCache.last_pushed_mtime)) {
      result.warnings.push({
        file: filename,
        error_message:
          `local modificado após o último sync (mudanças NÃO-enviadas) — pull NÃO sobrescreveu pra não clobberar trabalho fresco (#1828). ` +
          `Rode 'push' se o local for o correto, ou 'pull --force-overwrite-local' pra trazer o Drive mesmo assim.`,
      });
      return;
    }
  }

  // #89: se arquivo foi convertido pra Doc nativo no push, pull faz export
  // pra text/markdown em vez de download binário (alt=media retorna 403 pra Docs).
  const isGoogleDoc = fileCache.drive_mimeType === GOOGLE_DOC_MIME;
  const bytes = isGoogleDoc
    ? await driveExportFile(fileCache.drive_file_id, "text/markdown")
    : await driveDownloadFile(fileCache.drive_file_id);

  const dir = resolve(ROOT, editionDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // #1188: arquivos exportados de Google Doc voltam com escapes de markdown
  // adicionados pelo Drive (\#, \_, [url](url), etc). Sanitizar antes de
  // sobrescrever local. Apenas pra CONVERT_TO_DOC + mime markdown — outros
  // (imagens, JSON, etc) ficam intactos.
  const pathBase = pathBasename(filename);
  if (isGoogleDoc && CONVERT_TO_DOC.has(pathBase)) {
    const text = bytes.toString("utf8");
    const sanitized = unescapeMarkdown(text);
    writeFileSync(localPath, sanitized, "utf8");
  } else {
    writeFileSync(localPath, bytes);
  }

  const newMtime = statSync(localPath).mtimeMs;
  cache.editions[yymmdd].files[filename] = {
    ...fileCache,
    drive_modifiedTime: driveModified,
    last_pushed_mtime: newMtime,
  };

  result.pulled.push({
    file: filename,
    drive_file_id: fileCache.drive_file_id,
    drive_modifiedTime: driveModified,
    overwrote_local: true,
  });
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/**
 * #2318: Factory para o dedup guard de invalid_grant (#2318).
 * Retorna uma função que emite `OAUTH_EXPIRED_ALERT` em `result.warnings`
 * UMA VEZ (true na 1ª chamada, false nas subsequentes).
 *
 * Exportado para testes — permite testar o guard real sem chamar main().
 * main() usa este factory internamente para a mesma lógica de dedup.
 *
 * Uso em tests:
 *   const guard = makeInvalidGrantGuard(result);
 *   guard(); // → true (emite alerta, warnings.length === 1)
 *   guard(); // → false (dedup: sem duplicata)
 */
export function makeInvalidGrantGuard(result: SyncResult): () => boolean {
  let emitted = false;
  return (): boolean => {
    if (emitted) return false;
    emitted = true;
    result.warnings.push({ file: "(oauth)", error_message: OAUTH_EXPIRED_ALERT });
    return true;
  };
}

/**
 * Health check — chamada Drive API mínima pra validar OAuth (#121).
 * Lista 1 arquivo qualquer no root. Sucesso = token válido. Falha
 * com 401/403 = re-autenticar.
 */
async function healthCheck(): Promise<void> {
  const t0 = Date.now();
  try {
    await driveList("'root' in parents and trashed = false", "files(id,name)");
    const dt = Date.now() - t0;
    console.log(JSON.stringify({ ok: true, latency_ms: dt }, null, 2));
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // #2318: use OAUTH_EXPIRED_ALERT text so healthCheck remediation stays in
    // sync with the alert emitted mid-pipeline (single source of truth).
    const isAuthErr = classifyOAuthError(msg) === "invalid_grant";
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: msg,
          remediation: isAuthErr
            ? OAUTH_EXPIRED_ALERT
            : "Erro de Drive API. Verifique conectividade e credenciais.",
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { flags, values } = parseCliArgs(args); // #535: fix indexOf+1 bug

  // Health check mode — independent of edition/files (#121).
  if (flags.has("health-check")) {
    await healthCheck();
    return;
  }

  const mode = values["mode"] ?? "";
  const editionDir = values["edition-dir"] ?? "";
  const stage = parseInt(values["stage"] ?? "0", 10);
  const filesStr = values["files"] ?? "";
  // #963: --on-conflict pull-merge|warn|force. Default mantém compat ("warn").
  const onConflictRaw = values["on-conflict"] ?? "warn";
  const onConflict: ConflictMode = (
    ["warn", "pull-merge", "force"].includes(onConflictRaw) ? onConflictRaw : "warn"
  ) as ConflictMode;
  // #1828: ignora o guard de frescor do pull (sobrescreve local com Drive).
  const forceOverwriteLocal =
    values["force-overwrite-local"] !== undefined ||
    process.argv.includes("--force-overwrite-local");

  if (!mode || !editionDir) {
    console.error(
      "Usage: drive-sync.ts --mode push|pull --edition-dir data/editions/YYMMDD/ --stage N --files file1.md,file2.jpg\n" +
        "Or: drive-sync.ts --health-check"
    );
    process.exit(1);
  }

  const files = filesStr ? filesStr.split(",").map((f) => f.trim()).filter(Boolean) : [];
  const yymmdd = editionDir.replace(/\/$/, "").split("/").pop() ?? "";

  const result: SyncResult = {
    mode,
    stage,
    edition: yymmdd,
    day_folder_path: `Work/Startups/diar.ia/edicoes/${yymmdd.slice(0, 4)}/${editionDir.includes("/monthly/") ? "mensal" : yymmdd}`,
    uploaded: [],
    pulled: [],
    warnings: [],
  };

  if (files.length === 0) {
    result.skipped = true;
    result.skip_reason = "no_files";
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const cache = loadCache();

  // #2318: dedup guard — invalid_grant é emitido UMA VEZ, não por arquivo.
  // Quando o refresh token está morto, TODA operação Drive vai falhar com o mesmo
  // motivo. Em vez de N warnings idênticos (1 por arquivo), emitimos 1 alerta
  // claro e actionable e pulamos os arquivos restantes.
  let invalidGrantEmitted = false;

  /**
   * Emite alerta de invalid_grant UMA vez e retorna true na primeira chamada
   * (false nas subsequentes — para uso em guards: `if (!emitInvalidGrantAlert()) return`).
   * Delegates para makeInvalidGrantGuard — factory exportado para testes (#2318).
   */
  const _guardFactory = makeInvalidGrantGuard(result);
  function emitInvalidGrantAlert(): boolean {
    const wasNew = _guardFactory();
    if (wasNew) invalidGrantEmitted = true;
    return wasNew;
  }

  try {
    const edicoesId = await resolveEdicoesFolder(cache);
    const isMonthly = editionDir.includes("/monthly/");
    const dayFolderId = await resolveDayFolder(cache, yymmdd, edicoesId, isMonthly);

    for (const filename of files) {
      // #2318: se invalid_grant já foi detectado, não tentar arquivos restantes.
      if (invalidGrantEmitted) break;

      try {
        const localPath = resolve(ROOT, editionDir, filename);
        if (!existsSync(localPath) && mode === "push") {
          result.warnings.push({ file: filename, error_message: "arquivo local não encontrado" });
          continue;
        }

        if (mode === "push") {
          await pushFile(editionDir, filename, yymmdd, dayFolderId, cache, result, { onConflict });
        } else {
          await pullFile(editionDir, filename, yymmdd, cache, result, { forceOverwriteLocal });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // #2318: invalid_grant → alerta único em vez de warning por arquivo.
        if (classifyOAuthError(msg) === "invalid_grant") {
          emitInvalidGrantAlert();
        } else {
          result.warnings.push({ file: filename, error_message: msg });
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // #2318: invalid_grant no setup (folder resolution) → alerta único.
    if (classifyOAuthError(msg) === "invalid_grant") {
      emitInvalidGrantAlert();
    } else {
      result.warnings.push({ file: "(global)", error_message: msg });
    }
  } finally {
    saveCache(cache);
  }

  // Observabilidade: quando há warnings, gravar evento estruturado em
  // run-log.jsonl. O orchestrator não trava o pipeline (warnings nunca
  // bloqueiam — princípio existente), mas /diaria-log mostra a falha
  // pro editor reagir. Endereça #121: silent push failures viravam
  // invisíveis sem essa trilha.
  if (result.warnings.length > 0) {
    logSyncWarnings(result);
  }

  console.log(JSON.stringify(result, null, 2));

  // #977: opt-in fail-on-warning. Default mantém exit 0 mesmo com warnings
  // (compatibilidade com chamadas existentes). Quando flag ligada:
  //   --fail-on-warning           exit 2 se há QUALQUER warning não-oauth;
  //                               exit 3 se há oauth-expiry (remediação diferente)
  //   --fail-on-conflict          exit 2 só se há warning de CONFLICT
  //   --fail-on-oauth             exit 3 só se há oauth-expiry
  // Conflito do editor (#496/#605/#963) é categoria especial: indica que
  // o Drive tem edições do editor que o pipeline não pegou — orchestrator
  // precisa pular pra modo halt em vez de seguir achando que push deu certo.
  // OAuth expiry (#2318) usa exit 3 pra distinguir de CONFLICT (exit 2):
  // remediação é re-auth (oauth-setup.ts), não pull — callers precisam tratar
  // os dois casos de forma diferente.
  if (result.warnings.length > 0) {
    const failOnWarning = flags.has("fail-on-warning");
    const failOnConflict = flags.has("fail-on-conflict");
    const failOnOauth = flags.has("fail-on-oauth");
    const hasConflict = result.warnings.some((w) =>
      w.error_message.startsWith("CONFLICT:"),
    );
    const hasOauth = result.warnings.some((w) => w.file === "(oauth)");
    if (hasOauth && (failOnOauth || failOnWarning)) {
      process.exit(3);
    }
    if (failOnWarning || (failOnConflict && hasConflict)) {
      process.exit(2);
    }
  }
}

function logSyncWarnings(result: SyncResult): void {
  // #612: delega pra scripts/lib/run-log.ts. logEvent já encapsula resolve do
  // path (config + fallback) e swallow de exceções.
  // #2318: oauth expiry is logged at 'error' (requires immediate re-auth action);
  // other warnings remain at 'warn'. Without this, /diaria-log 260618 error
  // returns nothing for an oauth alert, making it invisible to error-level filters.
  const hasOauthAlert = result.warnings.some((w) => w.file === "(oauth)");
  logEvent({
    edition: result.edition,
    stage: result.stage,
    agent: "drive-sync",
    level: hasOauthAlert ? "error" : "warn",
    message: `${result.warnings.length} sync warning(s) em ${result.mode} (Stage ${result.stage})`,
    details: {
      mode: result.mode,
      warnings: result.warnings,
      uploaded_count: result.uploaded.length,
      pulled_count: result.pulled.length,
    },
  }, ROOT);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((err) => {
    console.error("drive-sync fatal:", err.message);
    process.exit(1);
  });
}

