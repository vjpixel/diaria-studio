/**
 * force-push-report.ts (one-off) — bypassa sync-report.ts pra push direto
 * quando o 3-way merge entra em loop de conflito. Atualiza snapshot pós-push.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gFetch } from "./google-auth.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fileArg = process.argv[2];
const idArg = process.argv[3];
if (!fileArg || !idArg) { console.error("usage: tsx force-push-report.ts <file> <drive_file_id>"); process.exit(2); }

const localPath = resolve(ROOT, fileArg);
const content = readFileSync(localPath, "utf8");
const snapshotDir = join(dirname(localPath), ".snapshots");
const snapshotPath = join(snapshotDir, basename(localPath).replace(/\.md$/, ".snapshot.md"));

const boundary = "boundary" + Math.random().toString(36).slice(2);
const body =
  `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n` +
  `--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;

const res = await gFetch(`https://www.googleapis.com/upload/drive/v3/files/${idArg}?uploadType=multipart`, {
  method: "PATCH",
  headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
  body,
});

if (!res.ok) {
  console.error(`FAIL ${res.status}: ${await res.text()}`);
  process.exit(1);
}

mkdirSync(snapshotDir, { recursive: true });
writeFileSync(snapshotPath, content, "utf8");
console.log(JSON.stringify({ ok: true, action: "force_pushed", file_id: idArg, bytes: content.length, snapshot_reset: snapshotPath }, null, 2));
