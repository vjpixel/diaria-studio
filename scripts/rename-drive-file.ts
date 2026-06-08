/**
 * rename-drive-file.ts (one-off) — renomeia o título (filename) de um Drive file
 */
import { gFetch } from "./google-auth.ts";
const [id, newName] = process.argv.slice(2);
if (!id || !newName) { console.error("usage: tsx rename-drive-file.ts <file_id> <new_name>"); process.exit(2); }

const res = await gFetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: newName }),
});
if (!res.ok) { console.error(`FAIL ${res.status}: ${await res.text()}`); process.exit(1); }
console.log(JSON.stringify(await res.json(), null, 2));
