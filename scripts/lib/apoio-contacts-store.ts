/**
 * scripts/lib/apoio-contacts-store.ts (#5899)
 *
 * Store de contatos do CRM de Apoios (apoia.se) — extraído VERBATIM de
 * `scripts/studio-ui/studio-apoios.ts` pela regra 4 de
 * `test/lib-boundary.test.ts` (#5899): `scripts/lib/**` não importa de
 * `scripts/studio-ui/**`. Quem puxava isso pra dentro de lib/ era
 * `apoio-reconciliation-cycle.ts` (importNewApoiadoresFromGmail/
 * loadContacts/saveContacts/ApoioContact) — lógica de dados pura que nunca
 * devolveu ao servidor HTTP nada do que tomou emprestado.
 *
 * `studio-apoios.ts` REEXPORTA tudo que moveu pra cá — rotas do server e
 * testes existentes continuam importando de lá sem mudança. Mesmo padrão da
 * extração do `apoio-month-key.ts` (que já tinha quebrado um ciclo
 * studio-apoios ↔ sync-apoio-nivel-beehiiv).
 *
 * LGPD inalterado: contatos vivem SÓ em `data/apoia-se/contacts.jsonl`
 * (junction OneDrive local, blanket-gitignored — nunca no repo, nunca em KV).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { ApoioNotification } from "./apoia-se-gmail-drain.ts";
import { writeFileAtomic } from "./atomic-write.ts";

// ── tipos ────────────────────────────────────────────────────────────────

export interface ApoioContact {
  id: string;
  name: string;
  /** Múltiplos emails — mitiga a ressalva de match exato da apoia.se. */
  emails: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

// ── parsing / serialização (puro) ───────────────────────────────────────

/** Normaliza/dedup lista de emails (trim + lowercase). Exportado porque
 * as rotas de update do Studio validam emails com a MESMA regra (#5899). */
export function normalizeEmailList(emails: string[] | undefined | null): string[] {
  if (!Array.isArray(emails)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const e = (raw ?? "").trim().toLowerCase();
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

/** Parseia `contacts.jsonl` (1 JSON por linha, linhas vazias ignoradas).
 *
 * Compat (#3611): linhas legadas podem trazer um campo `circle` (removido
 * do schema) — `Partial<ApoioContact>` já não o tipa, e como o objeto
 * resultante só copia os campos abaixo, `circle` simplesmente nunca é lido
 * nem propagado. Nunca quebra o parse.
 *
 * Compat (#3844): mesma disciplina pro campo `outreach` (removido do schema
 * junto com toda a maquinaria de follow-up/outreach) — linhas legadas que
 * ainda trazem `outreach[]` no `contacts.jsonl` real não quebram o parse, o
 * campo simplesmente nunca é lido nem propagado num roundtrip. O dado
 * histórico fica quieto no arquivo (nunca apagado por este código). */
export function parseContactsJsonl(raw: string): ApoioContact[] {
  const contacts: ApoioContact[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as Partial<ApoioContact>;
    contacts.push({
      id: String(parsed.id ?? randomUUID()),
      name: String(parsed.name ?? ""),
      emails: normalizeEmailList(parsed.emails),
      notes: String(parsed.notes ?? ""),
      createdAt: String(parsed.createdAt ?? new Date(0).toISOString()),
      updatedAt: String(parsed.updatedAt ?? new Date(0).toISOString()),
    });
  }
  return contacts;
}

export function serializeContactsJsonl(contacts: ApoioContact[]): string {
  if (contacts.length === 0) return "";
  return contacts.map((c) => JSON.stringify(c)).join("\n") + "\n";
}

// ── CRUD puro ────────────────────────────────────────────────────────────

export interface CreateContactInput {
  name: string;
  emails: string[];
  notes?: string;
}

export interface CreateContactOptions {
  /** Injetável pra testes determinísticos (default: `randomUUID()`). */
  id?: string;
  now?: Date;
}

export function createContact(input: CreateContactInput, opts: CreateContactOptions = {}): ApoioContact {
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("apoios: campo 'name' é obrigatório");
  const emails = normalizeEmailList(input.emails);
  if (emails.length === 0) throw new Error("apoios: contato precisa de ao menos 1 email em 'emails'");
  const now = opts.now ?? new Date();
  const iso = now.toISOString();
  return {
    id: opts.id ?? randomUUID(),
    name,
    emails,
    notes: input.notes ?? "",
    createdAt: iso,
    updatedAt: iso,
  };
}

export interface UpdateContactPatch {
  name?: string;
  emails?: string[];
  notes?: string;
}

/** Aplica um patch parcial a um contato existente — campos omitidos ficam
 * inalterados. Lança se `emails` for passado e resultar em lista vazia
 * (contato sempre precisa de ao menos 1 email). */
export function applyContactUpdate(
  contact: ApoioContact,
  patch: UpdateContactPatch,
  now: Date = new Date(),
): ApoioContact {
  let emails = contact.emails;
  if (patch.emails !== undefined) {
    emails = normalizeEmailList(patch.emails);
    if (emails.length === 0) throw new Error("apoios: contato precisa de ao menos 1 email em 'emails'");
  }
  const name = patch.name !== undefined ? patch.name.trim() : contact.name;
  if (!name) throw new Error("apoios: campo 'name' não pode ficar vazio");
  return {
    ...contact,
    name,
    emails,
    notes: patch.notes !== undefined ? patch.notes : contact.notes,
    updatedAt: now.toISOString(),
  };
}

export function findContact(contacts: ApoioContact[], id: string): ApoioContact | undefined {
  return contacts.find((c) => c.id === id);
}

/** Substitui (por id) ou adiciona um contato à lista — imutável (nova array). */
export function upsertContact(contacts: ApoioContact[], contact: ApoioContact): ApoioContact[] {
  const idx = contacts.findIndex((c) => c.id === contact.id);
  if (idx === -1) return [...contacts, contact];
  const copy = contacts.slice();
  copy[idx] = contact;
  return copy;
}

/**
 * Aplica notificações "novo apoio" (já drenadas + parseadas do Gmail, #3859
 * metade 1) sobre a lista de contatos: cria 1 contato novo por notificação
 * cujo email NÃO bate com nenhum email já cadastrado em NENHUM contato —
 * notificações cujo email já existe são ignoradas (nunca duplica, mesmo se
 * a mesma pessoa aparecer 2x na mesma leva de notificações). Pure — sem I/O;
 * o caller decide se/quando persistir com `saveContacts`.
 */
export function importNewApoiadoresFromGmail(
  contacts: ApoioContact[],
  notifications: ApoioNotification[],
): { contacts: ApoioContact[]; mutated: boolean; imported: number } {
  let result = contacts;
  let imported = 0;
  for (const notif of notifications) {
    const email = notif.email.trim().toLowerCase();
    if (!email) continue;
    const alreadyExists = result.some((c) => normalizeEmailList(c.emails).includes(email));
    if (alreadyExists) continue;
    const created = createContact({
      name: notif.name,
      emails: [email],
      notes: "importado automaticamente via e-mail apoia.se",
    });
    result = upsertContact(result, created);
    imported++;
  }
  return { contacts: result, mutated: imported > 0, imported };
}

// ── I/O: contacts.jsonl ───────────────────────────────────────────────

export function contactsFilePath(rootDir: string): string {
  return resolve(rootDir, "data", "apoia-se", "contacts.jsonl");
}

export function loadContacts(rootDir: string): ApoioContact[] {
  const path = contactsFilePath(rootDir);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(`apoios: falha lendo ${path}: ${(e as Error).message}`);
  }
  try {
    return parseContactsJsonl(raw);
  } catch (e) {
    throw new Error(`apoios: ${path} corrompido (JSON inválido em alguma linha): ${(e as Error).message}`);
  }
}

export function saveContacts(rootDir: string, contacts: ApoioContact[]): void {
  const path = contactsFilePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, serializeContactsJsonl(contacts));
}
