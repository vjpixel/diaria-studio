/**
 * #13179 — com o Google Drive para desktop desmontado (Neo, 15/11/2026), o
 * junction `data/` fica pendente e os scripts que leem `data/` falhavam com
 * erro genérico ("não encontrado", zero candidatos, ENOENT no mkdir), sem
 * apontar a causa. A sonda do #12547 só cobria `data/sessions`; aqui ela
 * vira genérica (`probeDataPath`) e entra nos pontos de entrada dos scripts:
 * `find-current-edition.ts` (Stage 0 e skills 2-6) e `resolveEditionDirArg`
 * (publishers do Stage 5).
 *
 * Os testes de sonda pura injetam `fs` e rodam em qualquer plataforma; os de
 * link real usam symlink e pulam no win32 (o junction real já é coberto em
 * `test/sessions-dir-probe-12547.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  brokenDataLinkMessage,
  detectSyncProvider,
  explainDataPathUnavailable,
  probeDataPath,
} from "../scripts/lib/data-dir-probe.mjs";
import { brokenSessionsLinkMessage, probeSessionsDir } from "../scripts/lib/sessions-dir-probe.mjs";
import { EditionDirArgError, resolveEditionDirArg } from "../scripts/lib/resolve-edition-dir-arg.ts";
import { describeDataUnavailable } from "../scripts/lib/find-current-edition.ts";

const ROOT = join("R:", "repo");
const DATA = join(ROOT, "data");
const EDITIONS = join(DATA, "editions");
const GDRIVE_TARGET = "I:\\Meu Drive\\diaria-studio-data";
const ONEDRIVE_TARGET = "C:\\Users\\vjpixel\\OneDrive\\diaria-studio-data";

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** `fs` falso: `entries` mapeia path → "dir" | "link-ok" | "link-broken" | código de erro do lstat. */
function fakeFs(entries: Record<string, string>, targets: Record<string, string> = {}) {
  return {
    lstatSync(p: string) {
      const e = entries[p];
      if (e === undefined) throw errno("ENOENT");
      if (e !== "dir" && e !== "link-ok" && e !== "link-broken") throw errno(e);
      return { isSymbolicLink: () => e !== "dir" };
    },
    statSync(p: string) {
      for (const [path, kind] of Object.entries(entries)) {
        if (kind === "link-broken" && (p === path || p.startsWith(path + "\\") || p.startsWith(path + "/"))) {
          throw errno("ENOENT");
        }
      }
      if (entries[p] === undefined) throw errno("ENOENT");
      return {};
    },
    readlinkSync(p: string) {
      if (targets[p] === undefined) throw errno("EINVAL");
      return targets[p];
    },
  };
}

describe("probeDataPath (#13179) — fs injetado", () => {
  it("caminho presente → present", () => {
    const fs = fakeFs({ [DATA]: "dir", [EDITIONS]: "dir" });
    assert.deepEqual(probeDataPath(ROOT, ["editions"], fs), { state: "present", degraded: false });
  });

  it("clone fresco (sem data/) → absent, sem degradar", () => {
    assert.deepEqual(probeDataPath(ROOT, ["editions", "2611", "261116"], fakeFs({})), { state: "absent", degraded: false });
  });

  it("data/ real, edição que não existe → absent", () => {
    const fs = fakeFs({ [DATA]: "dir", [EDITIONS]: "dir" });
    assert.deepEqual(probeDataPath(ROOT, ["editions", "2611", "261116"], fs), { state: "absent", degraded: false });
  });

  it("data/ link saudável, edição que não existe → absent", () => {
    const fs = fakeFs({ [DATA]: "link-ok", [EDITIONS]: "dir" });
    assert.deepEqual(probeDataPath(ROOT, ["editions", "2611", "261116"], fs), { state: "absent", degraded: false });
  });

  it("junction data/ → Google Drive desmontado: broken-link nomeando o Google Drive", () => {
    const fs = fakeFs({ [DATA]: "link-broken" }, { [DATA]: GDRIVE_TARGET });
    const p = probeDataPath(ROOT, ["editions", "2611", "261116"], fs);
    assert.equal(p.state, "broken-link");
    assert.equal(p.degraded, true);
    if (p.state === "broken-link") {
      assert.equal(p.path, DATA);
      assert.equal(p.target, GDRIVE_TARGET);
      assert.equal(p.provider, "google-drive");
      assert.match(p.message, /data\/ indisponível/);
      assert.match(p.message, /Google Drive desmontado\?/);
      assert.match(p.message, /Meu Drive/);
    }
  });

  it("junction data/ → OneDrive fechado: mensagem aponta o OneDrive (comportamento OneDrive preservado)", () => {
    const fs = fakeFs({ [DATA]: "link-broken" }, { [DATA]: ONEDRIVE_TARGET });
    const p = probeDataPath(ROOT, ["editions"], fs);
    assert.equal(p.state, "broken-link");
    if (p.state === "broken-link") {
      assert.equal(p.provider, "onedrive");
      assert.match(p.message, /OneDrive fechado\?/);
      assert.doesNotMatch(p.message, /Google Drive desmontado/);
    }
  });

  it("alvo ilegível (readlink falha) → mensagem cita os dois clientes de sync", () => {
    const p = probeDataPath(ROOT, [], fakeFs({ [DATA]: "link-broken" }));
    assert.equal(p.state, "broken-link");
    if (p.state === "broken-link") {
      assert.equal(p.provider, "unknown");
      assert.equal(p.target, undefined);
      assert.match(p.message, /Google Drive desmontado/);
      assert.match(p.message, /OneDrive/);
    }
  });

  it("link pendente num componente abaixo de data/ (data/editions) → broken-link nele", () => {
    const fs = fakeFs({ [DATA]: "dir", [EDITIONS]: "link-broken" }, { [EDITIONS]: GDRIVE_TARGET });
    const p = probeDataPath(ROOT, ["editions", "2611"], fs);
    assert.equal(p.state, "broken-link");
    if (p.state === "broken-link") assert.equal(p.path, EDITIONS);
  });

  it("lstat com erro que não é ENOENT → unreadable", () => {
    const p = probeDataPath(ROOT, ["editions", "2611"], fakeFs({ [EDITIONS]: "EACCES" }));
    assert.equal(p.state, "unreadable");
    assert.equal(p.degraded, true);
  });

  it("nunca lança, nem com fs que lança coisa estranha", () => {
    const weird = {
      lstatSync: () => {
        throw "string-thrown";
      },
      statSync: () => {
        throw undefined;
      },
    };
    assert.equal(probeDataPath(ROOT, ["editions"], weird as never).degraded, true);
  });
});

describe("detectSyncProvider / brokenDataLinkMessage (#13179)", () => {
  it("classifica os alvos conhecidos", () => {
    assert.equal(detectSyncProvider(GDRIVE_TARGET), "google-drive");
    assert.equal(detectSyncProvider("/Users/x/Library/CloudStorage/GoogleDrive-a@b/My Drive/d"), "google-drive");
    assert.equal(detectSyncProvider(ONEDRIVE_TARGET), "onedrive");
    assert.equal(detectSyncProvider("/mnt/outro"), "unknown");
    assert.equal(detectSyncProvider(undefined), "unknown");
  });

  it("mensagem traz o caminho, o código e a ação", () => {
    const m = brokenDataLinkMessage(DATA, "ENOENT", GDRIVE_TARGET);
    assert.ok(m.includes(DATA));
    assert.ok(m.includes("ENOENT"));
    assert.match(m, /Abra o Google Drive para desktop/);
  });
});

describe("explainDataPathUnavailable (#13179)", () => {
  it("caminho fora de data/ → null", () => {
    const fs = fakeFs({ [DATA]: "link-broken" });
    assert.equal(explainDataPathUnavailable(ROOT, join(ROOT, "scripts", "x.ts"), fs), null);
  });

  it("data/ saudável, arquivo inexistente → null", () => {
    const fs = fakeFs({ [DATA]: "dir" });
    assert.equal(explainDataPathUnavailable(ROOT, join(EDITIONS, "2611", "261116"), fs), null);
  });

  it("data/ pendente → mensagem", () => {
    const fs = fakeFs({ [DATA]: "link-broken" }, { [DATA]: GDRIVE_TARGET });
    assert.match(String(explainDataPathUnavailable(ROOT, join(EDITIONS, "2611", "261116"), fs)), /Google Drive desmontado/);
  });
});

describe("sessions-dir-probe segue com o texto do #12547 (#13179)", () => {
  it("alvo desconhecido/Google Drive → texto original do registro de sessões", () => {
    const p = probeSessionsDir(ROOT, fakeFs({ [DATA]: "link-broken" }, { [DATA]: GDRIVE_TARGET }));
    assert.equal(p.state, "broken-link");
    if (p.state === "broken-link") {
      assert.match(p.message, /data\/ aponta para um alvo indisponível/);
      assert.match(p.message, /Drive for desktop fechado\?/);
    }
    assert.equal(brokenSessionsLinkMessage(DATA, "ENOENT"), brokenSessionsLinkMessage(DATA, "ENOENT", GDRIVE_TARGET));
  });

  it("alvo OneDrive → ação aponta o OneDrive", () => {
    const p = probeSessionsDir(ROOT, fakeFs({ [DATA]: "link-broken" }, { [DATA]: ONEDRIVE_TARGET }));
    if (p.state === "broken-link") assert.match(p.message, /OneDrive fechado\?/);
    else assert.fail(`esperava broken-link, veio ${p.state}`);
  });
});

// ─── Link real (symlink) ─────────────────────────────────────────────────────

const POSIX_ONLY = { skip: process.platform === "win32" ? "symlink de diretório no Windows exige privilégio" : false };

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "data-probe-13179-"));
}

/** `{root}/data` → alvo que não existe, nomeado como a pasta do Google Drive. */
function linkDataToUnmountedDrive(root: string): void {
  symlinkSync(join(root, "GoogleDrive-desmontado", "Meu Drive", "diaria-studio-data"), join(root, "data"), "dir");
}

describe("pontos de entrada dos scripts com data/ pendente (#13179)", () => {
  it("resolveEditionDirArg: data/ pendente → EditionDirArgError com a causa", POSIX_ONLY, () => {
    const root = freshRoot();
    try {
      linkDataToUnmountedDrive(root);
      assert.throws(
        () => resolveEditionDirArg("data/editions/2611/261116/", { root }),
        (e: unknown) => e instanceof EditionDirArgError && /Google Drive desmontado\?/.test(e.message),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveEditionDirArg: data/ real, edição ausente → devolve o path (cada publisher trata)", POSIX_ONLY, () => {
    const root = freshRoot();
    try {
      mkdirSync(join(root, "data", "editions"), { recursive: true });
      assert.equal(resolveEditionDirArg("data/editions/2611/261116/", { root }), resolve(root, "data/editions/2611/261116"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("describeDataUnavailable: pendente → mensagem; saudável → null", POSIX_ONLY, () => {
    const broken = freshRoot();
    const healthy = freshRoot();
    try {
      linkDataToUnmountedDrive(broken);
      assert.match(String(describeDataUnavailable(broken, "data/editions")), /Google Drive desmontado\?/);
      mkdirSync(join(healthy, "data"));
      assert.equal(describeDataUnavailable(healthy, "data/editions"), null);
    } finally {
      rmSync(broken, { recursive: true, force: true });
      rmSync(healthy, { recursive: true, force: true });
    }
  });

  it("CLI find-current-edition --stage 2 / --resolve: data/ pendente → exit 1 com a causa no stderr", POSIX_ONLY, () => {
    const root = freshRoot();
    const script = resolve("scripts/lib/find-current-edition.ts");
    // cwd é o root temporário (o CLI resolve `data/` a partir do cwd), então o
    // loader do tsx vai por URL absoluta, não pelo nome do pacote.
    const tsxLoader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
    try {
      linkDataToUnmountedDrive(root);
      for (const args of [["--stage", "2"], ["--resolve", "261116"]]) {
        const r = spawnSync(process.execPath, ["--import", tsxLoader, script, ...args], { cwd: root, encoding: "utf8" });
        assert.equal(r.status, 1, `${args.join(" ")}: stderr=${r.stderr}`);
        assert.match(r.stderr, /\[erro\] data\/ indisponível/);
        assert.match(r.stderr, /Google Drive desmontado\?/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
