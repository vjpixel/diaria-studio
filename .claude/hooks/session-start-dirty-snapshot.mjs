#!/usr/bin/env node
// SessionStart hook: foto do checkout sujo no início da sessão (#11785).
//
// `scripts/session-close-check.ts` (usado por `/diaria-encerra`) compara o
// `git status` do encerramento com esta foto e só bloqueia o que apareceu ou
// mudou de hash depois dela; o resto sai em `preExisting`, sem afetar
// `canClose`. Captura e comparação moram em `lib/session-dirty-snapshot.mjs`.
//
// Só no `source: "startup"`. Em `resume`/`compact`/`clear` não grava: depois de
// um reboot o tmp some, e uma foto tirada no resume marcaria como
// pré-existente o que a própria sessão sujou antes, um falso "pode encerrar".
// Sem foto, o close-check volta ao critério antigo (mtime) e avisa que a
// atribuição não foi feita por hash. A 1ª foto da sessão vence (`wx`).
//
// Fail-soft total: nunca emite saída, nunca bloqueia nem lança. Custa um
// `git status` + hash dos arquivos sujos, uma vez por sessão.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { captureDirtySnapshot, snapshotFilePath, writeSnapshotOnce } from "./lib/session-dirty-snapshot.mjs";

/** Lógica testável do hook. Devolve o motivo de não ter gravado, ou o caminho gravado. */
export function runDirtySnapshotHook(payload, deps = {}) {
  const capture = deps.capture ?? captureDirtySnapshot;
  const write = deps.write ?? writeSnapshotOnce;
  const sessionId = payload?.session_id;
  if (payload?.source !== "startup") return { written: false, reason: "source-not-startup" };
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const snapshot = capture(cwd);
  if (!snapshot) return { written: false, reason: "too-many-entries" };
  const path = snapshotFilePath(sessionId, snapshot.checkout, deps.baseDir);
  if (!path) return { written: false, reason: "invalid-session-id" };
  return write(path, snapshot) ? { written: true, path } : { written: false, reason: "already-exists", path };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runDirtySnapshotHook(JSON.parse(readFileSync(0, "utf8") || "{}"));
  } catch {
    // Fail-soft: sem foto, o close-check cai no critério antigo e diz isso.
  }
}
