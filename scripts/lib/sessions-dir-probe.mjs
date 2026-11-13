// #12547 — "`data/sessions` ausente" tem duas causas que pedem respostas
// opostas, e `existsSync` não separa uma da outra:
//
//   - o diretório nunca existiu (clone fresco, sessão cloud): "não há sessão
//     registrada" é a resposta honesta, sem degradação;
//   - `data` (ou `data/sessions`) é um link/junction cujo alvo sumiu. No Neo,
//     `data` é junction para `I:\Meu Drive\diaria-studio-data`; com o Drive
//     for desktop fechado a unidade `I:` desaparece, `existsSync` devolve
//     `false` e o guard de merge lia isso como "nenhuma rodada ativa", sem
//     aviso nenhum (fail-open silencioso).
//
// `lstat` acha o próprio link mesmo com o alvo fora do ar; `stat` segue o
// link e falha. É esse par que distingue os dois casos.
//
// JS sem dependência, para o hook `.claude/hooks/block-gh-pr-merge-subagent.mjs`
// importar direto (mesmo padrão de `protected-path-bash-write.mjs`) e
// `scripts/lib/session-registry.ts` usar a mesma regra. O `fs` é injetável
// para o teste simular o junction pendente em qualquer plataforma.

import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";

const defaultFs = { lstatSync, statSync };

/**
 * Mensagem que nomeia a causa e a ação. Um único texto para hook e registry,
 * para o editor reconhecer o caso venha de onde vier.
 */
export function brokenSessionsLinkMessage(linkPath, code) {
  return (
    `data/ aponta para um alvo indisponível: "${linkPath}" é um link/junction cujo destino não responde (${code}). ` +
    "Drive for desktop fechado? Abra o Google Drive e espere a unidade montar antes de confiar no registro de sessões."
  );
}

function unreadableSessionsDirMessage(path, code) {
  return (
    `"${path}" existe mas não pôde ser lido (${code}). ` +
    "O registro de sessões não é confiável até a leitura voltar a funcionar."
  );
}

function errCode(e) {
  return String(e?.code ?? e?.message ?? e);
}

/**
 * Sonda `{repoRoot}/data/sessions`.
 *
 * - `{ state: "present" }`: o diretório resolve (pode estar vazio).
 * - `{ state: "absent" }`: não existe e nenhum componente entre ele e a raiz
 *   do repo é link pendente. É o estado do clone fresco.
 * - `{ state: "broken-link", path, code, message }`: `data/sessions` ou `data`
 *   é link/junction cujo alvo não resolve.
 * - `{ state: "unreadable", path, code, message }`: o caminho existe (o
 *   `lstat` acha) mas o `stat` falha por outro motivo que não ENOENT.
 *
 * `degraded` é `true` nos dois últimos: quem consome trata como "não dá para
 * saber", nunca como "não há sessão". Nunca lança.
 */
export function probeSessionsDir(repoRoot, fs = defaultFs) {
  const dataDir = join(repoRoot, "data");
  const sessions = join(dataDir, "sessions");
  let firstErr;
  try {
    fs.statSync(sessions);
    return { state: "present", degraded: false };
  } catch (e) {
    firstErr = e;
  }
  // Do mais fundo para a raiz: `data/sessions` pode ser ele mesmo o link.
  for (const candidate of [sessions, dataDir]) {
    let lst;
    try {
      lst = fs.lstatSync(candidate);
    } catch (e) {
      const code = e?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      const c = errCode(e);
      return { state: "unreadable", degraded: true, path: candidate, code: c, message: unreadableSessionsDirMessage(candidate, c) };
    }
    if (lst.isSymbolicLink()) {
      try {
        fs.statSync(candidate);
      } catch (e) {
        const c = errCode(e);
        return { state: "broken-link", degraded: true, path: candidate, code: c, message: brokenSessionsLinkMessage(candidate, c) };
      }
      // Link que resolve: o alvo existe, só não tem `sessions/`. Ausência real.
      return { state: "absent", degraded: false };
    }
    // Componente real. `data/sessions` real com `stat` falhando por motivo
    // que não é ENOENT: existe e está ilegível. `data` real (ou
    // `data/sessions` real que sumiu entre as duas chamadas): ausente.
    if (candidate === sessions && firstErr?.code !== "ENOENT") {
      const c = errCode(firstErr);
      return { state: "unreadable", degraded: true, path: candidate, code: c, message: unreadableSessionsDirMessage(candidate, c) };
    }
    return { state: "absent", degraded: false };
  }
  return { state: "absent", degraded: false };
}
