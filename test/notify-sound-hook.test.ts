import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  normalizeEventType,
  commandExists,
  resolveSoundCommand,
} from "../.claude/hooks/notify-sound.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookPath = join(__dirname, "..", ".claude", "hooks", "notify-sound.mjs");

// #4830: regressão do bug original — `.claude/settings.json` chamava
// `powershell` direto pros hooks Stop/Notification, quebrando toda sessão
// Linux/macOS com `Stop hook error: powershell: not found`. Os testes abaixo
// travam o contrato central (resolveSoundCommand nunca lança, plataforma sem
// player resolve `null`) e, no final, exercitam o próprio processo CLI ao
// vivo — igual ao sintoma reportado — pra provar que o wrapper sempre sai 0
// sem stderr, com ou sem player disponível.

describe("normalizeEventType", () => {
  it("'stop' passa direto", () => {
    assert.equal(normalizeEventType("stop"), "stop");
  });

  it("qualquer outro valor (inclusive ausente/typo) cai em 'notification'", () => {
    assert.equal(normalizeEventType("notification"), "notification");
    assert.equal(normalizeEventType(undefined), "notification");
    assert.equal(normalizeEventType("bogus"), "notification");
  });
});

describe("commandExists", () => {
  it("true quando execFn não lança", () => {
    assert.equal(
      commandExists("paplay", () => ""),
      true,
    );
  });

  it("false quando execFn lança (binário ausente)", () => {
    assert.equal(
      commandExists("paplay", () => {
        throw new Error("not found");
      }),
      false,
    );
  });
});

describe("resolveSoundCommand — Windows (comportamento original preservado)", () => {
  it("stop → powershell + Media.SoundPlayer com o .wav de Stop original", () => {
    const result = resolveSoundCommand("stop", { platform: "win32" });
    assert.equal(result.command, "powershell");
    assert.ok(result.args.join(" ").includes("Windows Notify Messaging.wav"));
  });

  it("notification → powershell + Media.SoundPlayer com o .wav de Notification original", () => {
    const result = resolveSoundCommand("notification", { platform: "win32" });
    assert.equal(result.command, "powershell");
    assert.ok(result.args.join(" ").includes("Windows Notify System Generic.wav"));
  });

  it("Windows nunca depende de exists/fileExists (sempre resolve, mesmo com checks falhando)", () => {
    const result = resolveSoundCommand("stop", {
      platform: "win32",
      exists: () => false,
      fileExists: () => false,
    });
    assert.equal(result.command, "powershell");
  });
});

describe("resolveSoundCommand — macOS", () => {
  it("afplay disponível + som existe → comando afplay", () => {
    const result = resolveSoundCommand("stop", {
      platform: "darwin",
      exists: () => true,
      fileExists: () => true,
    });
    assert.deepEqual(result, { command: "afplay", args: ["/System/Library/Sounds/Glass.aiff"] });
  });

  it("afplay ausente → null (no-op)", () => {
    const result = resolveSoundCommand("stop", {
      platform: "darwin",
      exists: () => false,
      fileExists: () => true,
    });
    assert.equal(result, null);
  });

  it("som de sistema ausente no disco → null (no-op)", () => {
    const result = resolveSoundCommand("stop", {
      platform: "darwin",
      exists: () => true,
      fileExists: () => false,
    });
    assert.equal(result, null);
  });
});

describe("resolveSoundCommand — Linux", () => {
  it("paplay disponível + arquivo do tema presente → comando paplay", () => {
    const result = resolveSoundCommand("notification", {
      platform: "linux",
      exists: (bin) => bin === "paplay",
      fileExists: () => true,
    });
    assert.deepEqual(result, {
      command: "paplay",
      args: ["/usr/share/sounds/freedesktop/stereo/message.oga"],
    });
  });

  it("paplay ausente, canberra-gtk-play disponível → comando canberra-gtk-play por event id", () => {
    const result = resolveSoundCommand("stop", {
      platform: "linux",
      exists: (bin) => bin === "canberra-gtk-play",
      fileExists: () => false,
    });
    assert.deepEqual(result, { command: "canberra-gtk-play", args: ["-i", "complete"] });
  });

  it("paplay presente mas SEM o arquivo do tema no disco → cai pro canberra-gtk-play", () => {
    const result = resolveSoundCommand("stop", {
      platform: "linux",
      exists: () => true, // ambos os binários "existem"
      fileExists: () => false, // mas o arquivo de som não está no disco
    });
    assert.deepEqual(result, { command: "canberra-gtk-play", args: ["-i", "complete"] });
  });

  it("nenhum player disponível → null (no-op silencioso — é o cenário exato do #4830 numa máquina Linux sem servidor de som configurado)", () => {
    const result = resolveSoundCommand("stop", {
      platform: "linux",
      exists: () => false,
      fileExists: () => false,
    });
    assert.equal(result, null);
  });
});

describe("resolveSoundCommand — plataforma não coberta (fail-soft)", () => {
  it("cai no mesmo caminho POSIX de busca de player e resolve null sem nenhum disponível", () => {
    const result = resolveSoundCommand("stop", {
      platform: "freebsd",
      exists: () => false,
      fileExists: () => false,
    });
    assert.equal(result, null);
  });
});

describe("CLI end-to-end — contrato de exit code / stderr (#4830)", () => {
  it("sem player disponível (mock de PATH vazio) → exit 0 e stderr vazio, pra 'stop'", () => {
    const result = spawnSync(process.execPath, [hookPath, "stop"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it("sem player disponível (mock de PATH vazio) → exit 0 e stderr vazio, pra 'notification'", () => {
    const result = spawnSync(process.execPath, [hookPath, "notification"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it("argv ausente → ainda exit 0 e stderr vazio (fail-soft de argumento)", () => {
    const result = spawnSync(process.execPath, [hookPath], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  it("PATH real desta sessão (ambiente ao vivo, self-review #2038) → exit 0 e stderr vazio", () => {
    // Sem mock nenhum: exercita o PATH real da máquina que roda o teste. Nesta
    // sessão (Linux, sem paplay/canberra-gtk-play/powershell instalados) isto
    // é literalmente o cenário que o #4830 pede pra confirmar ao vivo.
    const result = spawnSync(process.execPath, [hookPath, "stop"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });
});
