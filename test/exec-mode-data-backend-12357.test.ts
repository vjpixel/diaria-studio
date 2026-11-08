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
import { classifyDataSyncBackend, detectDataSyncBackend, detectExecMode } from "../scripts/lib/exec-mode.ts";

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
