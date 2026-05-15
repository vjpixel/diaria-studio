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
 *   4. Save new snapshot pós-push
 *
 * Uso:
 *   npx tsx scripts/sync-report.ts --file <local> --file-id <drive_id>
 *   npx tsx scripts/sync-report.ts --file <local> --file-id <drive_id> --init-snapshot
 *     (primeira vez: registra snapshot baseado no local atual sem fazer merge)
 *   npx tsx scripts/sync-report.ts --file <local> --file-id <drive_id> --dry-run
 *     (mostra o merge proposto sem fazer push)
 *
 * Limitações conhecidas:
 *   - Race window: se usuário edita Drive entre o export (pull) e o push, essas
 *     edições são silenciosamente perdidas. Janela típica < 30s, mas vale evitar
 *     rodar enquanto o usuário está ativamente editando.
 *   - Round-trip MD→Doc→MD: Google Docs reformata o markdown. Pequenas mudanças
 *     de whitespace/lista podem virar "diff" entre runs. Tolerado pelo merge.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gFetch } from "./google-auth.ts";
import { attemptThreeWayMerge } from "./drive-sync.ts";
import { unescapeMarkdown } from "./lib/markdown-unescape.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; }
      else { out[key] = true; }
    }
  }
  return out;
}

function snapshotPathFor(localPath: string): string {
  const dir = dirname(localPath);
  const base = basename(localPath).replace(/\.md$/, ".snapshot.md");
  return join(dir, ".snapshots", base);
}

/** Cria path-variant seguro mesmo se localPath não termina em .md (evita
 * overwrite acidental do original quando replace(/\.md$/) é no-op). */
function makeVariantPath(originalPath: string, variant: string): string {
  if (originalPath.endsWith(".md")) {
    return originalPath.slice(0, -3) + `.${variant}.md`;
  }
  return `${originalPath}.${variant}.md`;
}

async function exportDocAsMarkdown(fileId: string): Promise<string> {
  const url = `${DRIVE_API}/files/${fileId}/export?mimeType=text/markdown`;
  const res = await gFetch(url);
  if (!res.ok) throw new Error(`export ${fileId}: ${res.status} ${await res.text()}`);
  const raw = await res.text();
  return unescapeMarkdown(raw);
}

async function pushMarkdownToDoc(fileId: string, content: string): Promise<void> {
  const boundary = "boundary" + Math.random().toString(36).slice(2);
  const metadata = {}; // PATCH: keep current metadata
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/markdown; charset=UTF-8\r\n\r\n` +
    content + `\r\n` +
    `--${boundary}--`;
  const url = `${DRIVE_UPLOAD}/files/${fileId}?uploadType=multipart`;
  const res = await gFetch(url, {
    method: "PATCH",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`PATCH Drive file ${fileId}: ${res.status} ${await res.text()}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const localFile = args.file as string;
  const fileId = args["file-id"] as string;
  const initSnapshot = !!args["init-snapshot"];
  const dryRun = !!args["dry-run"];
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

  console.error(`[1/5] Lendo local: ${localFile}`);
  const local = readFileSync(localPath, "utf8");

  console.error(`[2/5] Lendo snapshot (base do merge): ${snapshotPath}`);
  const base = readFileSync(snapshotPath, "utf8");

  console.error(`[3/5] Exportando Doc do Drive (id=${fileId})...`);
  const remote = await exportDocAsMarkdown(fileId);

  // Sanity check: se remote << base, provavelmente API problem ou Doc apagado.
  // Aborta pra não propagar deleção via merge.
  if (remote.length < base.length * 0.5 && base.length > 1000) {
    console.error(`\n⚠️ ABORT: remote (${remote.length}b) é menos da metade do base (${base.length}b).`);
    console.error(`Possíveis causas: Doc esvaziado, export falhou, formato corrompido.`);
    console.error(`Inspeção manual recomendada antes de continuar.`);
    process.exit(5);
  }

  console.error(`[4/5] 3-way merge (local + base + remote)...`);
  const m = attemptThreeWayMerge(local, base, remote);

  if (m.hasConflicts) {
    const conflictPath = makeVariantPath(localPath, `merged-${Date.now()}`);
    writeFileSync(conflictPath, m.merged, "utf8");
    console.error(`\n⚠️ CONFLITO: ${m.conflictCount} conflito(s) detectado(s).`);
    console.error(`Salvo em: ${conflictPath}`);
    console.error(`Inspecione manualmente (procure por '<<<<<<<' / '>>>>>>>'), resolva os conflitos,`);
    console.error(`copie pra ${localFile}, e re-rode esse script.`);
    process.exit(1);
  }

  if (dryRun) {
    const previewPath = makeVariantPath(localPath, `dryrun-${Date.now()}`);
    writeFileSync(previewPath, m.merged, "utf8");
    console.error(`\n[5/5] DRY-RUN: merge preview salvo em ${previewPath}`);
    console.error(`Drive não foi modificado. Compare com Drive Doc pra decidir se vale push.`);
    console.log(JSON.stringify({
      ok: true, action: "dry_run_only",
      file_id: fileId,
      local_bytes: local.length, remote_bytes: remote.length, merged_bytes: m.merged.length,
      preview_path: previewPath,
    }, null, 2));
    return;
  }

  console.error(`[5/5] Push merged para Drive + atualiza snapshot...`);
  await pushMarkdownToDoc(fileId, m.merged);
  writeFileSync(localPath, m.merged, "utf8");
  writeFileSync(snapshotPath, m.merged, "utf8");

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
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
