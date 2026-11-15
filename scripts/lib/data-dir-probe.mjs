// #13179 — generalização da sonda do #12547 (`sessions-dir-probe.mjs`) para
// qualquer caminho dentro de `data/`.
//
// `data/` é link/junction para a pasta sincronizada da máquina: no Neo,
// junction para `I:\Meu Drive\diaria-studio-data` (Google Drive para desktop,
// #12359); em máquinas que ainda não migraram, a pasta do OneDrive. Quando o
// cliente de sync cai, a unidade desmonta, o link fica pendente e qualquer
// `existsSync("data/...")` devolve `false`. Os scripts liam isso como
// "arquivo não existe" e saíam com erro genérico (ENOENT, "edição não
// encontrada", zero candidatos), sem dizer que a causa é o Drive desmontado.
// Na queda de 15/11/2026 a sessão perdeu `data/` no meio do trabalho e nada
// apontou a causa.
//
// `lstat` acha o próprio link mesmo com o alvo fora do ar; `stat` segue o link
// e falha. É esse par que separa "o arquivo não existe" de "data/ não resolve".
//
// JS sem dependência (o hook `.claude/hooks/block-gh-pr-merge-subagent.mjs`
// importa `sessions-dir-probe.mjs`, que delega para cá). O `fs` é injetável
// para o teste simular o link pendente em qualquer plataforma.

import { lstatSync, readlinkSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const defaultFs = { lstatSync, statSync, readlinkSync };

function errCode(e) {
  return String(e?.code ?? e?.message ?? e);
}

/**
 * Qual cliente de sync está por trás do alvo do link, pelo texto do alvo.
 * `"unknown"` quando o alvo não pôde ser lido ou não bate com nenhum padrão.
 */
export function detectSyncProvider(target) {
  if (typeof target !== "string" || target === "") return "unknown";
  if (/onedrive/i.test(target)) return "onedrive";
  if (/google[ _-]?drive|googledrive|drivefs|meu drive|my drive/i.test(target)) return "google-drive";
  return "unknown";
}

/**
 * Mensagem que nomeia a causa e a ação para um link/junction de `data/` cujo
 * alvo não responde. O texto do Google Drive é o default (é onde `data/` mora
 * desde o #12359); OneDrive ganha texto próprio quando o alvo o nomeia.
 */
export function brokenDataLinkMessage(linkPath, code, target) {
  const provider = detectSyncProvider(target);
  const alvo = typeof target === "string" && target !== "" ? ` (alvo: "${target}")` : "";
  const head = `data/ indisponível: "${linkPath}" é um link/junction cujo destino não responde${alvo} (${code}).`;
  if (provider === "onedrive") {
    return `${head} OneDrive fechado? Abra o OneDrive e espere a pasta sincronizar antes de rodar de novo.`;
  }
  if (provider === "google-drive") {
    return `${head} Google Drive desmontado? Abra o Google Drive para desktop e espere a unidade montar antes de rodar de novo.`;
  }
  return (
    `${head} Google Drive desmontado (ou OneDrive fechado, se esta máquina ainda usa)? ` +
    "Abra o cliente de sync e espere a pasta montar antes de rodar de novo."
  );
}

function unreadableDataPathMessage(path, code) {
  return `"${path}" existe mas não pôde ser lido (${code}). data/ não é confiável até a leitura voltar a funcionar.`;
}

function readLinkTarget(fs, path) {
  if (typeof fs.readlinkSync !== "function") return undefined;
  try {
    return String(fs.readlinkSync(path));
  } catch {
    return undefined;
  }
}

/**
 * Sonda `{repoRoot}/data/{...segments}`.
 *
 * - `{ state: "present" }`: o caminho resolve.
 * - `{ state: "absent" }`: não existe e nenhum componente entre ele e `data`
 *   é link pendente (clone fresco, arquivo que de fato não existe).
 * - `{ state: "broken-link", path, code, target?, provider, message }`: algum
 *   componente (`data` ou abaixo) é link/junction cujo alvo não resolve.
 * - `{ state: "unreadable", path, code, message }`: o caminho existe (o
 *   `lstat` acha) mas o `stat` falha por outro motivo que não ENOENT.
 *
 * `degraded` é `true` nos dois últimos: quem consome trata como "não dá para
 * saber", nunca como "não existe". `opts.linkMessage(path, code, target)`
 * troca o texto do link pendente (o registro de sessões usa o texto do
 * #12547). Nunca lança.
 */
export function probeDataPath(repoRoot, segments = [], fs = defaultFs, opts = {}) {
  const dataDir = join(repoRoot, "data");
  const target = segments.length > 0 ? join(dataDir, ...segments) : dataDir;
  const linkMessage = typeof opts.linkMessage === "function" ? opts.linkMessage : brokenDataLinkMessage;
  let firstErr;
  try {
    fs.statSync(target);
    return { state: "present", degraded: false };
  } catch (e) {
    firstErr = e;
  }
  // Do mais fundo para `data`: qualquer componente pode ser ele mesmo o link.
  const candidates = [];
  for (let i = segments.length; i >= 0; i--) {
    candidates.push(i === 0 ? dataDir : join(dataDir, ...segments.slice(0, i)));
  }
  for (const candidate of candidates) {
    let lst;
    try {
      lst = fs.lstatSync(candidate);
    } catch (e) {
      const code = e?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      const c = errCode(e);
      return { state: "unreadable", degraded: true, path: candidate, code: c, message: unreadableDataPathMessage(candidate, c) };
    }
    if (lst.isSymbolicLink()) {
      try {
        fs.statSync(candidate);
      } catch (e) {
        const c = errCode(e);
        const linkTarget = readLinkTarget(fs, candidate);
        return {
          state: "broken-link",
          degraded: true,
          path: candidate,
          code: c,
          ...(linkTarget !== undefined ? { target: linkTarget } : {}),
          provider: detectSyncProvider(linkTarget),
          message: linkMessage(candidate, c, linkTarget),
        };
      }
      // Link que resolve: o alvo existe, só não tem o resto do caminho.
      return { state: "absent", degraded: false };
    }
    // Componente real. O próprio alvo real com `stat` falhando por motivo que
    // não é ENOENT: existe e está ilegível. Componente acima real: ausente.
    if (candidate === target && firstErr?.code !== "ENOENT") {
      const c = errCode(firstErr);
      return { state: "unreadable", degraded: true, path: candidate, code: c, message: unreadableDataPathMessage(candidate, c) };
    }
    return { state: "absent", degraded: false };
  }
  return { state: "absent", degraded: false };
}

/**
 * Para um caminho que o script não achou: se ele mora em `{repoRoot}/data/` e
 * a causa é `data/` indisponível (link pendente ou ilegível), devolve a
 * mensagem que nomeia causa e ação; senão `null` (o arquivo de fato não
 * existe, ou o caminho está fora de `data/`). Nunca lança.
 */
export function explainDataPathUnavailable(repoRoot, absPath, fs = defaultFs) {
  // Relativo resolve contra o cwd, como o próprio `fs` faria com o path.
  const rel = relative(resolve(repoRoot, "data"), resolve(absPath));
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  const segments = rel === "" ? [] : rel.split(sep).filter((s) => s !== "");
  const probe = probeDataPath(repoRoot, segments, fs);
  return probe.degraded ? probe.message : null;
}
