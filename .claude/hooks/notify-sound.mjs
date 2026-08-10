// Stop/Notification hook — cross-platform notification sound (#4830).
//
// Sintoma original: `.claude/settings.json` chamava `powershell` direto pra
// tocar um .wav do Windows (`New-Object Media.SoundPlayer ...`). O arquivo é
// versionado e compartilhado entre máquinas — em qualquer sessão Linux/macOS
// não existe `powershell` nem os .wav do Windows, então TODO turno terminava
// com `Stop hook error: /bin/sh: 1: powershell: not found`. É ruído puro (som
// é só um "ping" opcional, não-bloqueante por natureza), mas poluía toda
// sessão não-Windows e treinava o editor a ignorar erro de hook.
//
// Este arquivo substitui o comando direto em `.claude/settings.json` — os
// hooks `Stop` e `Notification` passam a chamar
// `node .claude/hooks/notify-sound.mjs {stop|notification}`. Contrato
// invariável: **sempre** sai com exit 0 e sem stderr, em QUALQUER plataforma,
// com ou sem player de som disponível. Som é opcional; erro por falta dele
// não é.
//
// Resolução por plataforma (`resolveSoundCommand`):
//   - Windows (`win32`)  → `powershell` + `Media.SoundPlayer` (comportamento
//     original, preservado 1:1 — mesmos dois .wav de sistema).
//   - macOS (`darwin`)   → `afplay` sobre um som de sistema (`.aiff` embutido
//     no OS desde sempre).
//   - Linux/outros POSIX → tenta `paplay` (PulseAudio/PipeWire, o mais comum
//     em desktop Linux) com um som do tema freedesktop se o arquivo existir
//     no disco; senão tenta `canberra-gtk-play` (libcanberra, também comum);
//     se nenhum dos dois estiver disponível, **no-op silencioso** — retorna
//     `null` e o entrypoint não tenta rodar nada.
//
// Self-contained (nenhum import de `scripts/*.ts`), mesma razão documentada em
// `.claude/hooks/pr-create-review.mjs`: um import estático de `.ts` executa
// antes de qualquer try/catch deste arquivo e pode derrubar o hook inteiro
// (silenciosamente) num Node sem type-stripping nativo.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Sons do Windows — preserva o comportamento original (#4830 "Causa"). */
const WINDOWS_SOUNDS = {
  stop: "C:\\Windows\\Media\\Windows Notify Messaging.wav",
  notification: "C:\\Windows\\Media\\Windows Notify System Generic.wav",
};

/** Sons de sistema do macOS — presentes por padrão em qualquer instalação. */
const MACOS_SOUNDS = {
  stop: "/System/Library/Sounds/Glass.aiff",
  notification: "/System/Library/Sounds/Ping.aiff",
};

/**
 * Linux: arquivo do tema freedesktop (usado via `paplay` quando presente no
 * disco — varia por distro/tema instalado, por isso o `fileExists` check) e o
 * id de evento equivalente pra `canberra-gtk-play` (que resolve o som pelo
 * tema ativo do sistema, sem depender de um path fixo).
 */
const LINUX_SOUND_FILES = {
  stop: "/usr/share/sounds/freedesktop/stereo/complete.oga",
  notification: "/usr/share/sounds/freedesktop/stereo/message.oga",
};
const LINUX_CANBERRA_EVENTS = {
  stop: "complete",
  notification: "message-new-instant",
};

/**
 * Normaliza o eventType recebido via argv — qualquer valor não reconhecido
 * (arg ausente, typo) cai em `"notification"` (fail-soft: nunca lança, nunca
 * bloqueia por causa de um argumento inesperado).
 */
export function normalizeEventType(raw) {
  return raw === "stop" ? "stop" : "notification";
}

/**
 * Checa se um binário existe no PATH via `which`. Nunca lança — `false` em
 * qualquer falha (binário ausente, `which` ausente, timeout). `execFn`
 * injetável pra teste sem depender do PATH real da máquina.
 */
export function commandExists(bin, execFn = execFileSync) {
  try {
    execFn("which", [bin], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve o comando de som pra plataforma/eventType dados, ou `null` quando
 * nenhum player está disponível (no-op silencioso — o caso comum em Linux
 * sem servidor de som configurado, ou em qualquer plataforma não coberta).
 *
 * `platform`/`exists`/`fileExists` são injetáveis pra testar as 3 plataformas
 * a partir de qualquer máquina, sem mockar `process.platform` global nem
 * depender de binários/arquivos reais no disco de quem roda o teste.
 */
export function resolveSoundCommand(
  eventTypeRaw,
  { platform = process.platform, exists = commandExists, fileExists = existsSync } = {},
) {
  const eventType = normalizeEventType(eventTypeRaw);

  if (platform === "win32") {
    return {
      command: "powershell",
      args: ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${WINDOWS_SOUNDS[eventType]}').PlaySync()`],
    };
  }

  if (platform === "darwin") {
    const sound = MACOS_SOUNDS[eventType];
    if (fileExists(sound) && exists("afplay")) {
      return { command: "afplay", args: [sound] };
    }
    return null;
  }

  // Linux e demais POSIX: paplay primeiro (mais comum em desktop Linux),
  // depois canberra-gtk-play, depois no-op.
  const soundFile = LINUX_SOUND_FILES[eventType];
  if (exists("paplay") && fileExists(soundFile)) {
    return { command: "paplay", args: [soundFile] };
  }
  if (exists("canberra-gtk-play")) {
    return { command: "canberra-gtk-play", args: ["-i", LINUX_CANBERRA_EVENTS[eventType]] };
  }
  return null;
}

// #2019: CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por test/notify-sound-hook.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  try {
    const resolved = resolveSoundCommand(process.argv[2]);
    if (resolved) {
      spawnSync(resolved.command, resolved.args, { stdio: "ignore", timeout: 10_000 });
    }
  } catch {
    // Swallow everything: o contrato deste hook é nunca sair não-zero e
    // nunca escrever em stderr, com ou sem player disponível (#4830).
  }
  // Explícito e incondicional: mesmo se `spawnSync` acima retornar um
  // resultado com erro (player crashou, exit != 0 do player em si), o hook
  // em si sempre reporta sucesso ao harness — som é opcional, por definição
  // não pode reprovar o turno.
  process.exit(0);
}
