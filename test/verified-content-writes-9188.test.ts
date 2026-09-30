/**
 * #9188 — reorder-destaques.ts e promote-to-destaque.ts gravam as escritas de
 * CONTEÚDO (01-approved*.json, 02-reviewed.md, 03-social.md) num LOTE
 * verificado (`writeFilesVerified`, #9173). Regressão: uma falha ao gravar o
 * último arquivo do lote (03-social.md) deixava 01-approved*.json e
 * 02-reviewed.md já reescritos — estado misto. Agora o lote é revertido.
 *
 * A falha é injetada tornando 03-social.md somente-leitura (EACCES no
 * writeFileSync). Pulado quando roda como root (chmod não barra root).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteToDestaque } from "../scripts/promote-to-destaque.ts";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const URL_RADAR = "https://r.com/promovido";

function hl(n: number) {
  return { rank: n, score: 90 - n, bucket: "noticias", url: `https://x.com/d${n}`, article: { url: `https://x.com/d${n}`, title: `D${n}` } };
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ["_internal/01-approved.json", "_internal/01-approved-capped.json", "02-reviewed.md", "03-social.md"]) {
    out[f] = readFileSync(join(dir, f), "utf8");
  }
  return out;
}

describe("#9188: lote verificado de conteúdo reverte em falha parcial", { skip: isRoot }, () => {
  it("promoteToDestaque: 03-social.md não gravável → JSONs e 02-reviewed.md intactos", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-9188-promote-"));
    try {
      mkdirSync(join(dir, "_internal"));
      const approved = JSON.stringify({
        highlights: [hl(1), hl(2)],
        radar: [{ url: URL_RADAR, title: "R", score: 70, category: "noticias" }],
        use_melhor: [],
      });
      writeFileSync(join(dir, "_internal", "01-approved.json"), approved);
      writeFileSync(join(dir, "_internal", "01-approved-capped.json"), approved);
      writeFileSync(join(dir, "02-reviewed.md"), "**DESTAQUE 1 | IA**\n\nt1\n\n---\n\n**DESTAQUE 2 | IA**\n\nt2\n");
      writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\ns1\n\n## d2\n\ns2\n");
      const before = snapshot(dir);
      chmodSync(join(dir, "03-social.md"), 0o444);

      // O rollback do próprio 03-social.md também falha (EACCES) — inofensivo, ele
      // nunca foi alterado; o que importa é que os JSONs/md voltaram.
      assert.throws(() => promoteToDestaque(dir, URL_RADAR, 1), /EACCES/);
      assert.deepEqual(snapshot(dir), before);
    } finally {
      chmodSync(join(dir, "03-social.md"), 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reorder-destaques CLI: 03-social.md não gravável → JSONs e 02-reviewed.md intactos", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-9188-reorder-"));
    try {
      mkdirSync(join(dir, "_internal"));
      const approved = JSON.stringify({ highlights: [hl(1), hl(2), hl(3)] });
      writeFileSync(join(dir, "_internal", "01-approved.json"), approved);
      writeFileSync(join(dir, "_internal", "01-approved-capped.json"), approved);
      writeFileSync(
        join(dir, "02-reviewed.md"),
        "**DESTAQUE 1 | IA**\n\n**[Um](https://x.com/d1)**\n\nt1\n\n---\n\n" +
          "**DESTAQUE 2 | IA**\n\n**[Dois](https://x.com/d2)**\n\nt2\n\n---\n\n" +
          "**DESTAQUE 3 | IA**\n\n**[Três](https://x.com/d3)**\n\nt3\n",
      );
      writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\ns1\n\n## d2\n\ns2\n\n## d3\n\ns3\n");
      const before = snapshot(dir);
      chmodSync(join(dir, "03-social.md"), 0o444);

      const projectRoot = join(import.meta.dirname, "..");
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", join(projectRoot, "scripts", "reorder-destaques.ts"),
          "--edition", "999999", "--edition-dir", dir, "--new-order", "2,1,3"],
        { cwd: projectRoot, encoding: "utf8" },
      );
      assert.notEqual(r.status, 0, `CLI deveria falhar. stdout: ${r.stdout}`);
      assert.match(r.stderr, /EACCES/);
      assert.deepEqual(snapshot(dir), before);
      // Nenhum arquivo residual criado no lote.
      assert.deepEqual(readdirSync(dir).sort(), ["02-reviewed.md", "03-social.md", "_internal"]);
    } finally {
      chmodSync(join(dir, "03-social.md"), 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#9188: fiação — sem writeFileSync cru nos dois scripts", () => {
  for (const f of ["reorder-destaques.ts", "promote-to-destaque.ts"]) {
    it(f, () => {
      const src = readFileSync(join(import.meta.dirname, "..", "scripts", f), "utf8");
      assert.doesNotMatch(src, /\bwriteFileSync\(/);
      assert.match(src, /writeFilesVerified\(/);
    });
  }
});
