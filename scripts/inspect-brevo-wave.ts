/**
 * inspect-brevo-wave.ts (one-off — usado pra verificar wave slicing logic)
 *
 * Fetcha contatos de uma lista Brevo + compara com slice esperado de
 * data/clarice-subscribers/brevo-import-t01.csv.
 *
 * Uso: npx tsx scripts/inspect-brevo-wave.ts --list-id 13 --start 501 --end 750
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = process.env.BREVO_CLARICE_API_KEY;
if (!API_KEY) { console.error("BREVO_CLARICE_API_KEY missing"); process.exit(2); }

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1]; i++;
    }
  }
  return out;
}

async function fetchListContacts(listId: number): Promise<string[]> {
  const emails: string[] = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const url = `https://api.brevo.com/v3/contacts/lists/${listId}/contacts?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { "api-key": API_KEY!, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Brevo GET list ${listId} failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as { contacts: Array<{ email: string }>; count?: number };
    if (!data.contacts || data.contacts.length === 0) break;
    for (const c of data.contacts) emails.push(c.email.toLowerCase());
    if (data.contacts.length < limit) break;
    offset += limit;
  }
  return emails;
}

function readCsvSlice(start1based: number, end1based: number): string[] {
  const csv = readFileSync(resolve(ROOT, "data/clarice-subscribers/brevo-import-t01.csv"), "utf8");
  const lines = csv.split("\n").slice(1); // skip header
  const slice = lines.slice(start1based - 1, end1based)
    .map((l) => l.split(",")[0].toLowerCase().trim())
    .filter(Boolean);
  return slice;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const listId = Number(args["list-id"]);
  const start = Number(args.start);
  const end = Number(args.end);
  if (!listId || !start || !end) {
    console.error("usage: --list-id N --start N --end N");
    process.exit(2);
  }
  const brevoEmails = new Set(await fetchListContacts(listId));
  const csvEmails = readCsvSlice(start, end);
  const csvSet = new Set(csvEmails);
  const inBrevoNotCsv = [...brevoEmails].filter((e) => !csvSet.has(e));
  const inCsvNotBrevo = csvEmails.filter((e) => !brevoEmails.has(e));
  console.log(JSON.stringify({
    listId,
    expected_slice: { start, end, count: csvEmails.length },
    brevo_count: brevoEmails.size,
    match: brevoEmails.size === csvEmails.length && inBrevoNotCsv.length === 0 && inCsvNotBrevo.length === 0,
    in_brevo_but_not_in_csv_slice: inBrevoNotCsv.slice(0, 5),
    in_csv_slice_but_not_in_brevo: inCsvNotBrevo.slice(0, 5),
    overlap: csvEmails.length - inCsvNotBrevo.length,
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
