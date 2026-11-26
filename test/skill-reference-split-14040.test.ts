/**
 * #14040 — as skills de vídeo guardam os casos raros em `reference/*.md`,
 * lidos sob demanda pelo gatilho citado no SKILL.md.
 *
 * O risco que a issue registra é o agente pular um caso raro por não abrir a
 * referência. Este teste trava o que dá para travar sem execução:
 *  - todo `reference/*.md` é citado no SKILL.md pelo caminho completo (sem
 *    órfão, que ninguém abriria) e todo caminho citado existe;
 *  - toda `seção "X"` citada junto do caminho existe como título no arquivo;
 *  - cada referência abre com título e a linha `Gatilho:`;
 *  - os gatilhos de maior risco seguem no ponto do fluxo em que são lidos;
 *  - o SKILL.md não volta a crescer acima do teto sem que alguém decida.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { skillReferenceFiles } from "./_helpers/skill-text.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** Teto em bytes do SKILL.md (≈8% acima do tamanho medido no #14040). */
const SKILLS: Record<string, number> = {
  "diaria-video-montagem": 100_000, // era 118.553 B, ficou 91.911 B
  "diaria-publica": 113_000, // era 137.872 B, ficou 104.359 B
  "diaria-video-roteiro": 44_000, // era 48.474 B, ficou 40.203 B
};

const skillText = (s: string) => readFileSync(join(ROOT, ".claude", "skills", s, "SKILL.md"), "utf8");

for (const [skill, maxBytes] of Object.entries(SKILLS)) {
  describe(`#14040 ${skill}: SKILL.md + reference/`, () => {
    const text = skillText(skill);
    const refs = skillReferenceFiles(skill);
    const prefix = `.claude/skills/${skill}/reference/`;

    it("tem referências", () => {
      assert.ok(refs.length > 0, `${skill} sem reference/*.md`);
    });

    it("todo reference/*.md é citado no SKILL.md pelo caminho completo", () => {
      for (const f of refs) {
        assert.ok(text.includes(prefix + basename(f)), `${basename(f)} não é citado em ${skill}/SKILL.md (órfão)`);
      }
    });

    it("todo caminho de reference/ citado no SKILL.md existe", () => {
      const cited = [...text.matchAll(/\.claude\/skills\/([a-z0-9-]+)\/reference\/([A-Za-z0-9._-]+\.md)/g)];
      assert.ok(cited.length > 0);
      for (const m of cited) {
        assert.ok(existsSync(join(ROOT, ".claude", "skills", m[1], "reference", m[2])), `citado e ausente: ${m[0]}`);
      }
    });

    it("toda seção citada junto do caminho existe como título no arquivo", () => {
      const re = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([A-Za-z0-9._-]+\\.md)\`?, seção "([^"]+)"`, "g");
      for (const m of text.matchAll(re)) {
        const ref = readFileSync(join(ROOT, prefix, m[1]), "utf8");
        const headings = ref.split("\n").filter((l) => /^#{1,4} /.test(l)).map((l) => l.replace(/^#+ /, ""));
        assert.ok(headings.some((h) => h.startsWith(m[2])), `${m[1]}: seção "${m[2]}" não existe (títulos: ${headings.join(" | ")})`);
      }
    });

    it("cada referência abre com título e a linha de gatilho", () => {
      for (const f of refs) {
        const ref = readFileSync(f, "utf8");
        assert.match(ref, /^# \S/, `${basename(f)} sem título`);
        assert.match(ref, new RegExp(`Referência de \`/${skill}\`, lida sob demanda \\(#14040\\)\\. Gatilho: \\S`), `${basename(f)} sem gatilho`);
      }
    });

    it(`SKILL.md fica abaixo de ${maxBytes} bytes`, () => {
      const bytes = Buffer.byteLength(text, "utf8");
      assert.ok(
        bytes <= maxBytes,
        `${skill}/SKILL.md tem ${bytes} B (teto ${maxBytes}): caso raro novo vai para reference/*.md com gatilho citado no ponto de uso (#14040), ou o teto sobe por decisão registrada`,
      );
    });
  });
}

describe("#14040 gatilhos no ponto do fluxo", () => {
  it("publica: o item 7 do Fluxo híbrido e a Parte B mandam ler os passos B3a a B7 depois do Stage 6", () => {
    const t = skillText("diaria-publica");
    const item7 = t.slice(t.indexOf("7. **Depois do Stage 6:**"), t.indexOf("8. **Interrupção:**"));
    assert.match(item7, /reference\/vertical-depois-do-stage6\.md`: ler o arquivo inteiro aqui/);
    const stub = t.slice(t.indexOf("### Passos B3a a B7"), t.indexOf("## Relato único"));
    for (const passo of ["Passo B3a", "Passo B3b", "Passo B4", "Passo B5", "Passo B5b", "Corte avulso", "Passo B6", "Passo B7"]) {
      assert.ok(stub.includes(passo), `stub da Parte B sem ${passo}`);
    }
    // O B3 (grant + --publish em background) fica no SKILL.md: roda antes da Etapa 5.
    assert.match(t, /### Passo B3 — Reels por API[\s\S]*video-publish-authorize\.ts grant \{AAMMDD\} --part vertical/);
  });

  it("montagem: o Passo 0 do bruto local no Mac (#13229, PR #14026) segue no relato do SKILL.md", () => {
    const t = skillText("diaria-video-montagem");
    assert.match(t, /0\. \*\*Bruto local no Mac \(#13229\):\*\*/);
    assert.match(t, /node scripts\/video\/prepara-bruto-mac\.ts \{AAMMDD\}/);
  });

  it("montagem: os casos raros do Passo 1 nomeiam a condição observável e o arquivo", () => {
    const t = skillText("diaria-video-montagem");
    assert.match(t, /`audioOnly: true`[\s\S]{0,400}reference\/audio-only\.md/);
    assert.match(t, /mais de um vídeo solto na pasta, o `transcribe` para \(#12268\): ler `\.claude\/skills\/diaria-video-montagem\/reference\/multiarquivo\.md`/);
    assert.match(t, /Um `transcript\.json` existente nunca é retranscrito sem `--force`/);
  });

  it("roteiro: Passo 8 e formato react apontam a referência", () => {
    const t = skillText("diaria-video-roteiro");
    assert.match(t, /## Passo 8 — Conferir a gravação contra o roteiro \(#12754\)\n\n[^\n]*reference\/conferir-gravacao\.md/);
    assert.match(t, /### Formato react \(#13433\)\n\n[^\n]*reference\/formato-react\.md/);
  });
});
