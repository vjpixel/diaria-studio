/**
 * test/exec-mode-data-backend-12357.test.ts (#12357, épica #12353)
 *
 * Na transição OneDrive → Google Drive, `data/` pode apontar pros dois:
 * `detectExecMode` tem de dar `local` com o alvo no Drive (o sinal é só
 * "resolve como diretório", nunca o caminho), e `detectDataSyncBackend` diz
 * qual backend é, pelos caminhos típicos de cada OS.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyDataSyncBackend, detectDataSyncBackend, detectExecMode, isDataOnGdrive } from "../scripts/lib/exec-mode.ts";

describe("classifyDataSyncBackend (#12357)", () => {
  it("OneDrive em Linux, Windows e macOS", () => {
    for (const p of [
      "/home/vjpixel/OneDrive/Documentos/diaria-studio-data",
      "C:\\Users\\vjpix\\OneDrive\\Documentos\\diaria-studio-data",
      "/Users/vj/Library/CloudStorage/OneDrive-Personal/Documents/diaria-studio-data",
      "C:\\Users\\vj\\OneDrive - Memelab\\diaria-studio-data",
    ]) {
      assert.equal(classifyDataSyncBackend(p), "onedrive", p);
    }
  });

  it("Google Drive: HD do 300, Drive for desktop no Windows (G:) e no macOS, ~/GoogleDrive", () => {
    for (const p of [
      "/mnt/hd-sata/GoogleDrive/Documentos/diaria-studio-data",
      "G:\\Meu Drive\\diaria-studio-data",
      "G:/My Drive/diaria-studio-data",
      "H:\\My Drive\\diaria-studio-data",
      "/Users/vj/Library/CloudStorage/GoogleDrive-vjpixel@gmail.com/Meu Drive/diaria-studio-data",
      "/home/vj/GoogleDrive/diaria-studio-data",
      "/home/vj/Google Drive/diaria-studio-data",
    ]) {
      assert.equal(classifyDataSyncBackend(p), "gdrive", p);
    }
  });

  it("alvo fora dos dois = unsynced (data/ criado à mão, container)", () => {
    assert.equal(classifyDataSyncBackend("/home/user/diaria-studio/data"), "unsynced");
    assert.equal(classifyDataSyncBackend("/tmp/OneDriveBackup/data"), "unsynced");
  });

  it("detectDataSyncBackend: realpath injetado; falha = absent", () => {
    assert.equal(
      detectDataSyncBackend({ projectRoot: "/repo", realpathFn: () => "/mnt/hd-sata/GoogleDrive/x/diaria-studio-data" }),
      "gdrive",
    );
    assert.equal(
      detectDataSyncBackend({
        projectRoot: "/repo",
        realpathFn: () => {
          throw new Error("ENOENT");
        },
      }),
      "absent",
    );
  });
});

describe("detectExecMode com data/ apontando pro Drive (#12357)", { skip: process.platform === "win32" ? "symlink exige privilégio no Windows" : false }, () => {
  it("symlink real pra uma pasta GoogleDrive → local, backend gdrive", () => {
    const sb = mkdtempSync(join(tmpdir(), "exec-mode-12357-"));
    try {
      const target = join(sb, "GoogleDrive", "Documentos", "diaria-studio-data");
      mkdirSync(target, { recursive: true });
      const repo = join(sb, "repo");
      mkdirSync(repo);
      symlinkSync(target, join(repo, "data"));
      assert.equal(detectExecMode({ projectRoot: repo }), "local");
      assert.equal(detectDataSyncBackend({ projectRoot: repo }), "gdrive");
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});

describe("negativos e ambiguidade do classificador (review #12357)", () => {
  it("segmento parecido com Google Drive não conta", () => {
    for (const p of [
      "/home/vj/Google Drive Backup/x",
      "/home/vj/GoogleDriveX/x",
      "/home/vj/MyGoogleDrive/x",
      "/home/vj/My Drive Backup/x",
    ]) {
      assert.equal(classifyDataSyncBackend(p), "unsynced", p);
    }
  });
  it("OneDrive e GoogleDrive no mesmo caminho: OneDrive vence (checado primeiro, comportamento fixado)", () => {
    assert.equal(classifyDataSyncBackend("/mnt/hd-sata/GoogleDrive/OneDrive/diaria-studio-data"), "onedrive");
    assert.equal(classifyDataSyncBackend("/home/vj/OneDrive/GoogleDrive/diaria-studio-data"), "onedrive");
  });
});

describe("symlink de data/ quebrado (review #12357)", () => {
  const broken = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  it("alvo literal no Drive → gdrive-unreachable (P1 no alarme), nunca absent", () => {
    const b = detectDataSyncBackend({
      projectRoot: "/repo",
      realpathFn: broken,
      readLinkTargetFn: () => "/mnt/hd-sata/GoogleDrive/Documentos/diaria-studio-data",
    });
    assert.equal(b, "gdrive-unreachable");
    assert.equal(isDataOnGdrive(b), true);
    assert.equal(isDataOnGdrive("gdrive"), true);
    assert.equal(isDataOnGdrive("onedrive"), false);
    assert.equal(isDataOnGdrive("absent"), false);
  });
  it("junction do Windows pro G: quebrada também", () => {
    assert.equal(
      detectDataSyncBackend({ projectRoot: "C:\\repo", realpathFn: broken, readLinkTargetFn: () => "G:\\Meu Drive\\diaria-studio-data" }),
      "gdrive-unreachable",
    );
  });
  it("link quebrado pra OneDrive ou outro lugar, ou data/ que não é link → absent", () => {
    assert.equal(detectDataSyncBackend({ projectRoot: "/repo", realpathFn: broken, readLinkTargetFn: () => "/home/vj/OneDrive/x" }), "absent");
    assert.equal(detectDataSyncBackend({ projectRoot: "/repo", realpathFn: broken, readLinkTargetFn: () => "/tmp/x" }), "absent");
    assert.equal(detectDataSyncBackend({ projectRoot: "/repo", realpathFn: broken, readLinkTargetFn: () => null }), "absent");
    assert.equal(
      detectDataSyncBackend({
        projectRoot: "/repo",
        realpathFn: broken,
        readLinkTargetFn: () => {
          throw new Error("EPERM");
        },
      }),
      "absent",
    );
  });
  it("alvo relativo é resolvido a partir do repo", () => {
    assert.equal(
      detectDataSyncBackend({ projectRoot: "/home/vj/repo", realpathFn: broken, readLinkTargetFn: () => "../GoogleDrive/diaria-studio-data" }),
      "gdrive-unreachable",
    );
  });
});

describe("symlink real quebrado no disco (review #12357)", { skip: process.platform === "win32" ? "symlink exige privilégio no Windows" : false }, () => {
  it("HD desmontado: data/ → GoogleDrive inexistente = gdrive-unreachable, e detectExecMode cai pra cloud", () => {
    const sb = mkdtempSync(join(tmpdir(), "exec-mode-broken-12357-"));
    try {
      const repo = join(sb, "repo");
      mkdirSync(repo);
      symlinkSync(join(sb, "hd-sata", "GoogleDrive", "Documentos", "diaria-studio-data"), join(repo, "data"));
      assert.equal(detectDataSyncBackend({ projectRoot: repo }), "gdrive-unreachable");
      assert.notEqual(detectExecMode({ projectRoot: repo }), "local");
      // Sem data/ nenhum: absent.
      const bare = join(sb, "bare");
      mkdirSync(bare);
      assert.equal(detectDataSyncBackend({ projectRoot: bare }), "absent");
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});
