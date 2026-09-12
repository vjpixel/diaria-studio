import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { collectCurrentlyReferencedEmails } from "../scripts/clarice-unblock-orphaned-selections.ts";

// #8038 — collectCurrentlyReferencedEmails: universo de "quem ainda está em
// alguma onda viva do ciclo" (todo *.csv do diretório de segments).

test("collectCurrentlyReferencedEmails: une o email (1ª coluna) de todos os CSVs do diretório", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-"));
  writeFileSync(resolve(dir, "daily.csv"), "email,NOME\na@x.com,A\nb@x.com,B\n", "utf8");
  writeFileSync(resolve(dir, "novos.csv"), "email,NOME\nc@x.com,C\n", "utf8");
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out].sort(), ["a@x.com", "b@x.com", "c@x.com"]);
});

test("collectCurrentlyReferencedEmails: normaliza pra lowercase, ignora colunas além do email", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-norm-"));
  writeFileSync(resolve(dir, "engajados-priority-snapshot.csv"), "email,priority_points,cohort,priority_optin\nA@X.com,20,ex-assinantes,0\n", "utf8");
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out], ["a@x.com"]);
});

test("collectCurrentlyReferencedEmails: diretório ausente -> Set vazio, não lança", () => {
  const dir = resolve(tmpdir(), "unblock-collect-does-not-exist-" + Date.now());
  assert.deepEqual(collectCurrentlyReferencedEmails(dir), new Set());
});

test("collectCurrentlyReferencedEmails: arquivos não-CSV no diretório são ignorados", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-noncsv-"));
  writeFileSync(resolve(dir, "daily.csv"), "email\na@x.com\n", "utf8");
  writeFileSync(resolve(dir, "sent-or-queued.json"), '{"cycle":"x","emails":[],"history":[]}', "utf8");
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out], ["a@x.com"]);
});

test("collectCurrentlyReferencedEmails: subdiretório aninhado (ex: .mv-cache) não quebra a varredura — só lê arquivos, não recursa", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-subdir-"));
  writeFileSync(resolve(dir, "daily.csv"), "email\na@x.com\n", "utf8");
  mkdirSync(resolve(dir, "subpasta"));
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out], ["a@x.com"]);
});
