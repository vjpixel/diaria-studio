/**
 * split-wave-brevo.ts (one-off — split T1-W6 → 300 + nova T1-W7 com 48)
 *
 * Operação atômica:
 *   1. Lê emails do brevo-import-t01-W7.csv (48 contatos pra mover)
 *   2. Cria lista nova "T1-W7 (48 contatos)" no Brevo → captura novo list_id
 *   3. Adiciona os 48 emails à lista nova
 *   4. Remove os 48 emails da lista atual (T1-W6 = list 14)
 *
 * Idempotente: se a nova lista já existir com mesmo nome, abort (não duplica).
 *
 * Uso:
 *   npx tsx scripts/split-wave-brevo.ts --dry-run
 *   npx tsx scripts/split-wave-brevo.ts --apply
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = process.env.BREVO_CLARICE_API_KEY;
if (!API_KEY) { console.error("BREVO_CLARICE_API_KEY missing"); process.exit(2); }

const SOURCE_LIST_ID = 14; // T1-W6 antiga (348)
const NEW_LIST_NAME = "T1-W7 (48 contatos)";
const W7_CSV = "data/clarice-subscribers/brevo-import-t01-W7.csv";

async function brevoFetch(path: string, opts: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    ...opts,
    headers: {
      "api-key": API_KEY!,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Brevo ${opts.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function readEmailsFromCsv(path: string): string[] {
  const content = readFileSync(resolve(ROOT, path), "utf8");
  const lines = content.split("\n").slice(1); // skip header
  return lines
    .map((l) => l.split(",")[0].trim().toLowerCase())
    .filter((e) => e && e.includes("@"));
}

async function findExistingListByName(name: string): Promise<{ id: number; name: string; folderId: number } | null> {
  let offset = 0;
  for (;;) {
    const data = await brevoFetch(`/contacts/lists?limit=50&offset=${offset}&sort=desc`) as {
      lists: Array<{ id: number; name: string; folderId: number }>;
    };
    if (!data.lists || data.lists.length === 0) return null;
    for (const l of data.lists) {
      if (l.name === name) return l;
    }
    if (data.lists.length < 50) return null;
    offset += 50;
  }
}

async function getListInfo(listId: number): Promise<{ id: number; name: string; folderId: number; totalSubscribers: number }> {
  return await brevoFetch(`/contacts/lists/${listId}`) as { id: number; name: string; folderId: number; totalSubscribers: number };
}

async function createList(name: string, folderId: number): Promise<{ id: number }> {
  return await brevoFetch(`/contacts/lists`, {
    method: "POST",
    body: JSON.stringify({ name, folderId }),
  }) as { id: number };
}

async function addContactsToList(listId: number, emails: string[]): Promise<{ contacts: { success: string[]; failure: string[] } }> {
  return await brevoFetch(`/contacts/lists/${listId}/contacts/add`, {
    method: "POST",
    body: JSON.stringify({ emails }),
  }) as { contacts: { success: string[]; failure: string[] } };
}

async function removeContactsFromList(listId: number, emails: string[]): Promise<{ contacts: { success: string[]; failure: string[] } }> {
  return await brevoFetch(`/contacts/lists/${listId}/contacts/remove`, {
    method: "POST",
    body: JSON.stringify({ emails }),
  }) as { contacts: { success: string[]; failure: string[] } };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (!dryRun && !apply) {
    console.error("Especifique --dry-run ou --apply");
    process.exit(2);
  }

  console.error(`[split-wave-brevo] ${dryRun ? "DRY-RUN" : "APPLY"}`);
  const emails = readEmailsFromCsv(W7_CSV);
  console.error(`[1/5] Lidos ${emails.length} emails de ${W7_CSV}`);

  console.error(`[2/5] Verificando lista source (id ${SOURCE_LIST_ID})`);
  const sourceList = await getListInfo(SOURCE_LIST_ID);
  console.error(`      → "${sourceList.name}" com ${sourceList.totalSubscribers} assinantes, folderId=${sourceList.folderId}`);

  console.error(`[3/5] Verificando se "${NEW_LIST_NAME}" já existe`);
  const existing = await findExistingListByName(NEW_LIST_NAME);
  if (existing) {
    console.error(`      ⚠️ Lista já existe (id ${existing.id}) — abortando pra não duplicar`);
    process.exit(1);
  }

  if (dryRun) {
    console.error(`[4/5] DRY-RUN: criaria lista "${NEW_LIST_NAME}" em folder ${sourceList.folderId}`);
    console.error(`[5/5] DRY-RUN: moveria ${emails.length} emails (primeiros 3: ${emails.slice(0, 3).join(", ")})`);
    console.log(JSON.stringify({ mode: "dry-run", ok: true, source_list: SOURCE_LIST_ID, source_count: sourceList.totalSubscribers, target_name: NEW_LIST_NAME, emails_to_move: emails.length }, null, 2));
    return;
  }

  console.error(`[4/5] Criando lista "${NEW_LIST_NAME}"...`);
  const created = await createList(NEW_LIST_NAME, sourceList.folderId);
  console.error(`      → list_id=${created.id}`);

  console.error(`[5a/5] Adicionando ${emails.length} contatos à lista ${created.id}...`);
  const addRes = await addContactsToList(created.id, emails);
  console.error(`       → success: ${addRes.contacts.success.length}, failure: ${addRes.contacts.failure.length}`);
  if (addRes.contacts.failure.length > 0) {
    console.error(`       failures: ${addRes.contacts.failure.slice(0, 10).join(", ")}`);
  }

  console.error(`[5b/5] Removendo ${emails.length} contatos da lista ${SOURCE_LIST_ID}...`);
  const removeRes = await removeContactsFromList(SOURCE_LIST_ID, emails);
  console.error(`       → success: ${removeRes.contacts.success.length}, failure: ${removeRes.contacts.failure.length}`);

  // Verify final state
  const finalSource = await getListInfo(SOURCE_LIST_ID);
  const finalNew = await getListInfo(created.id);
  console.log(JSON.stringify({
    mode: "applied",
    ok: true,
    source: { id: SOURCE_LIST_ID, before: sourceList.totalSubscribers, after: finalSource.totalSubscribers },
    target: { id: created.id, name: NEW_LIST_NAME, after: finalNew.totalSubscribers },
    add_failures: addRes.contacts.failure,
    remove_failures: removeRes.contacts.failure,
  }, null, 2));
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
