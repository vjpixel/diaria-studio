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

import { lstatSync, readlinkSync, statSync } from "node:fs";
// #13179: a sonda virou genérica (`probeDataPath`, qualquer caminho em
// `data/`); este módulo mantém a API e o texto do #12547 para o registro de
// sessões e o guard de merge.
import { detectSyncProvider, probeDataPath } from "./data-dir-probe.mjs";

const defaultFs = { lstatSync, statSync, readlinkSync };

/**
 * Mensagem que nomeia a causa e a ação. Um único texto para hook e registry,
 * para o editor reconhecer o caso venha de onde vier. Com o alvo do link
 * nomeando o OneDrive (máquina que ainda não migrou, #12359), a ação aponta
 * para o OneDrive; senão, para o Google Drive (#13179).
 */
export function brokenSessionsLinkMessage(linkPath, code, target) {
  if (detectSyncProvider(target) === "onedrive") {
    return (
      `data/ aponta para um alvo indisponível: "${linkPath}" é um link/junction cujo destino não responde (${code}). ` +
      "OneDrive fechado? Abra o OneDrive e espere a pasta sincronizar antes de confiar no registro de sessões."
    );
  }
  return (
    `data/ aponta para um alvo indisponível: "${linkPath}" é um link/junction cujo destino não responde (${code}). ` +
    "Drive for desktop fechado? Abra o Google Drive e espere a unidade montar antes de confiar no registro de sessões."
  );
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
  return probeDataPath(repoRoot, ["sessions"], fs, { linkMessage: brokenSessionsLinkMessage });
}
