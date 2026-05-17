/**
 * sync-report.ts — sync seguro de relatórios Drive↔local com 3-way merge
 *
 * Diferente de upload-report-to-drive.ts (que faz overwrite destrutivo).
 * Usa attemptThreeWayMerge do drive-sync.ts pra preservar edições do editor
 * (Felipe ou outros) feitas direto no Google Doc.
 *
 * Fluxo:
 *   1. Pull: export do Doc como markdown + unescape (#1188)
 *   2. Load snapshot (.snapshots/{basename}.snapshot.md) — base do merge
 *   3. attemptThreeWayMerge(local, snapshot, remote)
 *      - sem conflito: push merged
 *      - com conflito: salva .merged-{ts}.md, aborta, instrui editor
 *   4. Verifica modifiedTime do Drive não mudou desde o pull (#1308 #5)
 *   5. Push merged
 *   6. Save new snapshot
 *
 * Uso:
 *   npx tsx scripts/sync-report.ts --file <local> --file-id <drive_id>
 *   npx tsx scripts/sync-report.ts --file <local> --file-id <drive_id> --init-snapshot
 *     (primeira vez: registra snapshot baseado no local atual sem fazer merge)
 *   npx tsx scripts/sync-report.ts --file <local> --file-id <drive_id> --dry-run
 *     (mostra o merge proposto sem fazer push)
 *
 * Exit codes (#1308 #11):
 *   0  — success (action emitido como JSON em stdout)
 *   1  — conflict no merge (`.merged-{ts}.md` salvo pro editor resolver)
 *   2  — usage error (args ausentes)
 *   3  — snapshot baseline não existe (rodar com --init-snapshot)
 *   4  — drive edited mid-sync (modifiedTime guard, #1308 #5)
 *   5  — sanity check failed (remote << base, possível Doc corrompido)
 *
 * Limitações conhecidas:
 *   - Race window pull→push (#1308 #5): mitigado por modifiedTime guard antes
 *     do push. Não elimina (janela entre fetch metadata e PATCH ainda existe ~1s),
 *     mas detecta edits realizados durante o merge. Drive-sync.ts tem
 *     `conflict_tolerance_seconds` (#605) pra ignorar bump de auto-conversion;
 *     sync-report não porta porque o push aqui é PATCH (não cria Doc).
 *   - Round-trip MD→Doc→MD: Google Docs reformata o markdown. Pequenas mudanças
 *     de whitespace/lista podem virar "diff" entre runs. Tolerado pelo merge.
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gFetch } from "./google-auth.ts";
import { attemptThreeWayMerge } from "./drive-sync.ts";
import { unescapeMarkdown } from "./lib/markdown-unescape.ts";
import { parseArgs } from "./lib/cli-args.ts"; // #1308 item 3
import { DRIVE_API, DRIVE_UPLOAD } from "./lib/drive-constants.ts"; // #1308 item 1
import { buildMultipartBody } from "./lib/drive-helpers.ts"; // #1308 item 4
import { writeFileAtomic } from "./lib/atomic-write.ts"; // #1308 item 9

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolve path do snapshot baseado no path local. Exportado pra tests (#1308 #13). */
export function snapshotPathFor(localPath: string): string {
  const dir = dirname(localPath);
  const base = basename(localPath).replace(/\.md$/, ".snapshot.md");
  return join(dir, ".snapshots", base);
}

/**
 * Cria path-variant seguro mesmo se localPath não termina em .md (evita
 * overwrite acidental do original quando replace(/\.md$/) é no-op).
 * Exportado pra tests (#1308 #13).
 */
export function makeVariantPath(originalPath: string, variant: string): string {
  if (originalPath.endsWith(".md")) {
    return originalPath.slice(0, -3) + `.${variant}.md`;
  }
  return `${originalPath}.${variant}.md`;
}

/** Lê só `modifiedTime` do Drive — usado pelo race guard (#1308 #5). */
async function fetchModifiedTime(fileId: string): Promise<string> {
  const res = await gFetch(`${DRIVE_API}/files/${fileId}?fields=modifiedTime`);
  if (!res.ok) throw new Error(`fetchModifiedTime ${fileId}: ${res.status} ${await res.text()}`);
  const data = await res.json() as { modifiedTime: string };
  return data.modifiedTime;
}

async function exportDocAsMarkdown(fileId: string): Promise<string> {
  const url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/markdown`;
  const res = await gFetch(url);
  if (!res.ok) throw new Error(`export ${fileId}: ${res.status} ${await res.text()}`);
  const raw = await res.text();
  return unescapeMarkdown(raw);
}

async function pushMarkdownToDoc(fileId: string, content: string): Promise<void> {
  const mp = buildMultipartBody({
    metadata: {}, // PATCH: keep current metadata
    contentType: "text/markdown; charset=UTF-8",
    content,
  });
  const url = `${DRIVE_UPLOAD}/files/${fileId}?uploadType=multipart`;
  const res = await gFetch(url, {
    method: "PATCH",
    headers: { "Content-Type": mp.contentType },
    body: mp.body,
  });
  if (!res.ok) throw new Error(`PATCH Drive file ${fileId}: ${res.status} ${await res.text()}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const localFile = args.values.file ?? "";
  const fileId = args.values["file-id"] ?? "";
  const initSnapshot = args.flags.has("init-snapshot");
  const dryRun = args.flags.has("dry-run");
  if (!localFile || !fileId) { console.error("usage: --file <path> --file-id <drive_id> [--init-snapshot] [--dry-run]"); process.exit(2); }

  const localPath = resolve(ROOT, localFile);
  if (!existsSync(localPath)) throw new Error(`local file not found: ${localPath}`);
  const snapshotPath = snapshotPathFor(localPath);

  if (initSnapshot) {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    copyFileSync(localPath, snapshotPath);
    console.log(JSON.stringify({ ok: true, action: "snapshot_initialized", snapshot: snapshotPath }));
    return;
  }

  if (!existsSync(snapshotPath)) {
    console.error(`ERRO: snapshot não existe em ${snapshotPath}.`);
    console.error(`Rode primeiro: --init-snapshot pra registrar baseline.`);
    console.error(`Importante: --init-snapshot trata o local atual como "última versão pushed". Se`);
    console.error(`o Drive já tem edições não-conhecidas, elas virão como diff "remote" na próxima`);
    console.error(`sync, o que é o comportamento desejado (3-way merge captura).`);
    process.exit(3);
  }

  console.error(`[1/6] Lendo local: ${localFile}`);
  const local = readFileSync(localPath, "utf8");

  console.error(`[2/6] Lendo snapshot (base do merge): ${snapshotPath}`);
  const base = readFileSync(snapshotPath, "utf8");

  console.error(`[3/6] Exportando Doc do Drive (id=${fileId})...`);
  const remote = await exportDocAsMarkdown(fileId);
  // #1308 #5 — captura baseline pra comparar antes do push e detectar
  // edits do editor durante a janela merge.
  const baselineModifiedTime = await fetchModifiedTime(fileId);

  // Sanity check: se remote << base, provavelmente API problem ou Doc apagado.
  // Aborta pra não propagar deleção via merge.
  if (remote.length < base.length * 0.5 && base.length > 1000) {
    console.error(`\n⚠️ ABORT: remote (${remote.length}b) é menos da metade do base (${base.length}b).`);
    console.error(`Possíveis causas: Doc esvaziado, export falhou, formato corrompido.`);
    console.error(`Inspeção manual recomendada antes de continuar.`);
    process.exit(5);
  }

  console.error(`[4/6] 3-way merge (local + base + remote)...`);
  const m = attemptThreeWayMerge(local, base, remote);

  if (m.hasConflicts) {
    const conflictPath = makeVariantPath(localPath, `merged-${Date.now()}`);
    writeFileAtomic(conflictPath, m.merged); // #1308 #9
    console.error(`\n⚠️ CONFLITO: ${m.conflictCount} conflito(s) detectado(s).`);
    console.error(`Salvo em: ${conflictPath}`);
    console.error(`Inspecione manualmente (procure por '<<<<<<<' / '>>>>>>>'), resolva os conflitos,`);
    console.error(`copie pra ${localFile}, e re-rode esse script.`);
    process.exit(1);
  }

  if (dryRun) {
    const previewPath = makeVariantPath(localPath, `dryrun-${Date.now()}`);
    writeFileAtomic(previewPath, m.merged); // #1308 #9
    console.error(`\n[5/6] DRY-RUN: merge preview salvo em ${previewPath}`);
    console.error(`Drive não foi modificado. Compare com Drive Doc pra decidir se vale push.`);
    console.log(JSON.stringify({
      ok: true, action: "dry_run_only",
      file_id: fileId,
      local_bytes: local.length, remote_bytes: remote.length, merged_bytes: m.merged.length,
      preview_path: previewPath,
    }, null, 2));
    return;
  }

  // #1308 #5 — race guard: se editor editou Drive durante o merge, aborta
  // pra evitar overwrite das edições. Janela residual ~1s entre esse check e
  // o PATCH (não eliminável sem locking server-side que Drive não expõe).
  console.error(`[5/6] Verificando que Drive não foi editado durante o merge...`);
  const currentModifiedTime = await fetchModifiedTime(fileId);
  if (currentModifiedTime !== baselineModifiedTime) {
    console.error(`\n⚠️ ABORT: Drive Doc foi editado durante o merge.`);
    console.error(`  baseline modifiedTime: ${baselineModifiedTime}`);
    console.error(`  current modifiedTime:  ${currentModifiedTime}`);
    console.error(`Re-rode o sync — as edições novas do Drive serão capturadas no próximo merge.`);
    process.exit(4);
  }

  console.error(`[6/6] Push merged para Drive + atualiza snapshot...`);
  await pushMarkdownToDoc(fileId, m.merged);
  writeFileAtomic(localPath, m.merged); // #1308 #9 — crítico (merged result)
  writeFileAtomic(snapshotPath, m.merged); // #1308 #9 — crítico (próximo merge depende)

  // Stats
  const localBytes = local.length;
  const remoteBytes = remote.length;
  const mergedBytes = m.merged.length;
  console.log(JSON.stringify({
    ok: true,
    action: "merged_and_pushed",
    file_id: fileId,
    local_bytes: localBytes,
    remote_bytes: remoteBytes,
    merged_bytes: mergedBytes,
    delta_from_local: mergedBytes - localBytes,
    delta_from_remote: mergedBytes - remoteBytes,
    snapshot_updated: snapshotPath,
  }, null, 2));
}
// Roda só quando invocado direto via CLI — não quando importado por tests (#1308 #13)
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
}
