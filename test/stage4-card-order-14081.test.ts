import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

const playbook = readFileSync(new URL("../.claude/agents/orchestrator-stage-4.md", import.meta.url), "utf8");
const step = playbook.split("**d. Disparar a regeneração")[1].split("**e. Dispatchar")[0];
const commands = step.split("```bash")[1].split("```")[0].replace(/\\\n\s*/g, " ")
  .split("\n").map(line => line.trim()).filter(Boolean);
const native = commands.filter(line => line.includes("--ratio 4x5"));

// Execute the actual playbook command with fake generators, never paid APIs.
const fakeNpx = `
npx() {
  case "$*" in
    *image-generate.ts*--ratio*)
      sleep 0.05
      echo native-finished
      return "$NATIVE_EXIT"
      ;;
    *gen-social-card-4x5.ts*) echo card-composed ;;
    *) return 99 ;;
  esac
}
`;

describe("Stage 4 card dependency (#14081)", () => {
  it("dispatches the native and card as one conditional background task", () => {
    assert.equal(native.length, 1);
    assert.match(native[0], /--ratio 4x5 --force\s*&&\s*npx tsx scripts\/gen-social-card-4x5\.ts/);
    assert.equal(commands.filter(line => line.includes("gen-social-card-4x5.ts")).length, 1);
    assert.match(commands.find(line => line.includes("--keep-4x5-nativo"))!, /image-generate\.ts/);
    assert.match(commands.find(line => line.includes("gen-carousel-cards.ts"))!, /^npx tsx scripts\/gen-carousel-cards\.ts/);
  });

  it("composes the card after native generation finishes successfully", () => {
    assert.ok(native[0]);
    const output = execFileSync("bash", ["-c", fakeNpx + native[0]], {
      env: { ...process.env, NATIVE_EXIT: "0" }, encoding: "utf8",
    });
    assert.deepEqual(output.trim().split("\n"), ["native-finished", "card-composed"]);
  });

  it("propagates native failure without composing a fallback card", () => {
    assert.ok(native[0]);
    const result = spawnSync("bash", ["-c", fakeNpx + native[0]], {
      env: { ...process.env, NATIVE_EXIT: "7" }, encoding: "utf8",
    });
    assert.equal(result.status, 7);
    assert.equal(result.stdout.trim(), "native-finished");
  });

  it("requires all image tasks to succeed and preserves any error", () => {
    assert.match(step, /Se o nativo sair != 0, não compor o card nem usar fallback do master\/2:1: marcar `image` como `error`/);
    assert.match(step, /Falha do card ou do 2:1 também marca `image` como `error`/);
    assert.match(step, /Só marcar `image` como `done` quando AMBAS as tasks de imagem/);
    assert.match(step, /sucesso posterior não sobrescreve `error`/);
    assert.match(step, /sua task marca apenas `carousel`/);
  });
});
