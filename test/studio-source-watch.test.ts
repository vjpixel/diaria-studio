import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import { watchStudioSource, type StudioSourceChange } from "../scripts/studio-ui/studio-source-watch.ts";

function waitForChange(
  rootDir: string,
  predicate: (change: StudioSourceChange) => boolean,
): Promise<StudioSourceChange> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      handle.close();
      reject(new Error("timed out waiting for Studio source change"));
    }, 1000);
    const handle = watchStudioSource(rootDir, (change) => {
      if (!predicate(change)) return;
      clearTimeout(timer);
      handle.close();
      resolve(change);
    }, { pollIntervalMs: 10 });
  });
}

describe("Studio server-rendered source watcher (#5674)", () => {
  it("reports mtime changes in both server-rendered source trees", async () => {
    const root = mkdtempSync(join(tmpdir(), "studio-source-watch-"));
    const studioFile = join(root, "scripts", "studio-ui", "rendered.ts");
    const workerFile = join(root, "workers", "brevo-dashboard", "src", "sections.ts");
    mkdirSync(join(root, "scripts", "studio-ui"), { recursive: true });
    mkdirSync(join(root, "workers", "brevo-dashboard", "src"), { recursive: true });
    writeFileSync(studioFile, "export const value = 1;\n");
    writeFileSync(workerFile, "export const value = 1;\n");

    const studioChange = waitForChange(root, (change) => change.path === "scripts/studio-ui/rendered.ts");
    utimesSync(studioFile, new Date(), new Date(Date.now() + 100));
    assert.equal((await studioChange).path, "scripts/studio-ui/rendered.ts");

    const workerChange = waitForChange(root, (change) => change.path === "workers/brevo-dashboard/src/sections.ts");
    utimesSync(workerFile, new Date(), new Date(Date.now() + 200));
    assert.equal((await workerChange).path, "workers/brevo-dashboard/src/sections.ts");
  });

  it("does not restart on unrelated files and is wired into startStudioServer", async () => {
    const root = mkdtempSync(join(tmpdir(), "studio-source-watch-server-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    const unrelated = join(root, "README.md");
    const source = join(root, "scripts", "studio-ui", "rendered.ts");
    mkdirSync(join(root, "scripts", "studio-ui"), { recursive: true });
    writeFileSync(unrelated, "initial\n");
    writeFileSync(source, "initial\n");
    const changes: StudioSourceChange[] = [];
    let server: StudioServer | undefined;
    server = await startStudioServer({
      port: 0,
      rootDir: root,
      enableSourceWatch: true,
      sourceWatchPollIntervalMs: 10,
      onSourceChange: (change) => changes.push(change),
    });

    utimesSync(unrelated, new Date(), new Date(Date.now() + 300));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(changes, []);

    utimesSync(source, new Date(), new Date(Date.now() + 400));
    for (let i = 0; i < 20 && changes.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(changes[0]?.path, "scripts/studio-ui/rendered.ts");
    await server.close();
  });

  it("#6452: debounces a burst of rapid mtime changes into a single onChange call", async () => {
    const root = mkdtempSync(join(tmpdir(), "studio-source-watch-debounce-"));
    const dir = join(root, "scripts", "studio-ui");
    mkdirSync(dir, { recursive: true });
    const fileA = join(dir, "a.ts");
    const fileB = join(dir, "b.ts");
    writeFileSync(fileA, "export const a = 1;\n");
    writeFileSync(fileB, "export const b = 1;\n");

    const changes: StudioSourceChange[] = [];
    const handle = watchStudioSource(root, (change) => changes.push(change), {
      pollIntervalMs: 10,
      debounceMs: 100,
    });

    // Simula um `git pull` tocando o mesmo (ou vários) arquivo(s) várias
    // vezes em rápida sucessão — exatamente o padrão do incidente #6452
    // (5 restarts em ~4min citando a mesma mudança). Cada `utimesSync` cai
    // dentro da janela de debounce da anterior.
    for (let i = 0; i < 5; i += 1) {
      utimesSync(fileA, new Date(), new Date(Date.now() + i * 10 + 100));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    utimesSync(fileB, new Date(), new Date(Date.now() + 500));

    // Ainda dentro da janela de debounce: nenhum onChange disparou ainda.
    assert.deepEqual(changes, []);

    // Espera o debounce estabilizar (bem além de debounceMs) e confirma que
    // só 1 restart foi sinalizado, não 1 por mudança de mtime observada.
    for (let i = 0; i < 40 && changes.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(changes.length, 1);
    handle.close();
  });
});
