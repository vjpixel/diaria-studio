/**
 * #13924 — o box da Retrospectiva (slot 2, alternado com o do Artigo
 * Especial) ficava sem `expires:` e seguia selecionado depois do ciclo.
 * `update-retrospectiva-box.ts` agora grava `expires:` no header — por padrão
 * o último dia do mês de ENVIO do ciclo — e a seleção
 * (`resolveBoxesForEdition`) pula a caixa vencida (#10174).
 *
 * Tudo em diretório temporário: `data/snippets/` é gitignored (#5227).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RETROSPECTIVA_BOX_FILENAME,
  RETROSPECTIVA_BOX_HEADER,
  RetrospectivaBoxFormatError,
  buildDefaultRetrospectivaBox,
  defaultRetrospectivaExpires,
  isIsoCalendarDate,
  renderRetrospectivaBox,
  runUpdateRetrospectivaBox,
  todayBrt,
} from "../scripts/update-retrospectiva-box.ts";
import { parseBoxHeaderField, readSnippetExpiry } from "../scripts/lib/shared/snippet-header.ts";
import { resolveBoxesForEdition, type BoxesDivulgacaoAutoConfig } from "../scripts/select-boxes-by-clicks.ts";

const TEMAS = ["agentes no trabalho", "chips sob disputa", "regulação no Brasil"];
const INPUT = { mesLabel: "Outubro", temas: TEMAS, url: "https://retrospectiva.diar.ia.br/2610" };

describe("defaultRetrospectivaExpires (#13924)", () => {
  it("último dia do mês de ENVIO, nunca do mês de conteúdo", () => {
    assert.equal(defaultRetrospectivaExpires("2610-11"), "2026-11-30");
    assert.equal(defaultRetrospectivaExpires("2609-10"), "2026-10-31");
  });

  it("virada de ano: ciclo 2612-01 vale até 31/01 do ano seguinte", () => {
    assert.equal(defaultRetrospectivaExpires("2612-01"), "2027-01-31");
  });

  it("fevereiro bissexto", () => {
    assert.equal(defaultRetrospectivaExpires("2801-02"), "2028-02-29");
    assert.equal(defaultRetrospectivaExpires("2701-02"), "2027-02-28");
  });

  it("ciclo inválido lança", () => {
    assert.throws(() => defaultRetrospectivaExpires("2610"), /ciclo inválido/);
  });
});

describe("todayBrt / isIsoCalendarDate (#13924)", () => {
  it("01/12 01:00 UTC ainda é 30/11 em BRT", () => {
    assert.equal(todayBrt(new Date("2026-12-01T01:00:00Z")), "2026-11-30");
  });
  it("rejeita data fora do calendário ou fora do formato", () => {
    assert.ok(isIsoCalendarDate("2026-11-30"));
    assert.ok(!isIsoCalendarDate("2026-02-30"));
    assert.ok(!isIsoCalendarDate("30/11/2026"));
  });
});

describe("renderRetrospectivaBox com expires (#13924)", () => {
  it("seed: grava expires no header e o resto é o seed de sempre", () => {
    const out = renderRetrospectivaBox(null, { ...INPUT, expires: "2026-11-30" });
    assert.equal(parseBoxHeaderField(out, "expires"), "2026-11-30");
    assert.equal(out.replace("expires: 2026-11-30\n", ""), buildDefaultRetrospectivaBox(INPUT));
  });

  it("reuso: troca só a linha expires (idempotente, cirúrgico)", () => {
    const first = renderRetrospectivaBox(null, { ...INPUT, expires: "2026-11-30" });
    const next = renderRetrospectivaBox(first, { ...INPUT, mesLabel: "Novembro", expires: "2026-12-31" });
    assert.equal(parseBoxHeaderField(next, "expires"), "2026-12-31");
    assert.equal(next.match(/^expires:/gm)?.length, 1);
    assert.ok(next.includes("**Retrospectiva de Novembro**"));
  });

  it("header legado do #9474 ainda é trocado pelo atual antes de ganhar expires", () => {
    const LEGACY_HEADER = `<!--
nome: Retrospectiva do Mês
categoria: Retrospectiva
retrospectiva-apoiadores.md — box de divulgação da Retrospectiva do Mês
(recompensa Mantenedor/Patrono, R$25+). Slot 2, ALTERNANDO com
artigo-especial-apoiadores.md (quem publica por último ocupa o slot, #9474).
Reescrito por scripts/update-retrospectiva-box.ts (/diaria-mensal-apoiadores)
a cada ciclo — não editar título/frase-padrão/URL do CTA à mão aqui, o
próximo ciclo sobrescreve (o parágrafo do tier segue estável). Formato:
context/snippets/README.md.
-->`;
    const seed = buildDefaultRetrospectivaBox(INPUT).replace(RETROSPECTIVA_BOX_HEADER, LEGACY_HEADER);
    const out = renderRetrospectivaBox(seed, { ...INPUT, expires: "2026-11-30" });
    assert.ok(out.startsWith("<!--\nexpires: 2026-11-30\nnome: Retrospectiva do Mês\n"));
    assert.ok(out.includes("(recompensa Conselho/Núcleo)"));
  });

  it("CRLF: o expires inserido segue o fim de linha do arquivo", () => {
    const crlf = buildDefaultRetrospectivaBox(INPUT).replace(/\n/g, "\r\n");
    const out = renderRetrospectivaBox(crlf, { ...INPUT, expires: "2026-11-30" });
    assert.ok(out.startsWith("<!--\r\nexpires: 2026-11-30\r\nnome: Retrospectiva do Mês\r\n"));
    assert.ok(!/(^|[^\r])\n/.test(out), "nenhum LF solto");
  });

  it("expires ausente deixa o header intocado (compatível)", () => {
    assert.equal(renderRetrospectivaBox(null, INPUT), buildDefaultRetrospectivaBox(INPUT));
  });

  it("formato divergente segue lançando RetrospectivaBoxFormatError", () => {
    assert.throws(
      () => renderRetrospectivaBox("**Outro box**\n\ntexto\n", { ...INPUT, expires: "2026-11-30" }),
      RetrospectivaBoxFormatError,
    );
  });

  it("expires inválido lança", () => {
    assert.throws(() => renderRetrospectivaBox(null, { ...INPUT, expires: "2026-13-01" }), /AAAA-MM-DD/);
  });
});

function auto(pinned: number[]): BoxesDivulgacaoAutoConfig {
  return { enabled: true, pinnedSlots: new Set(pinned as (1 | 2 | 3)[]), recentWindow: 3, priorWindow: 3, lastN: 20 };
}

describe("seleção: box da Retrospectiva vencido sai do slot 2 (#13924)", () => {
  it("pinado no slot 2: vale até o último dia do mês de envio, inclusive; no dia seguinte não chega ao stitch", () => {
    const dir = mkdtempSync(join(tmpdir(), "retro-expires-13924-"));
    try {
      const editionsDir = join(dir, "editions");
      const postsDir = join(dir, "posts");
      const snippetsDir = join(dir, "data", "snippets");
      for (const d of [editionsDir, postsDir, snippetsDir]) mkdirSync(d, { recursive: true });
      const box = renderRetrospectivaBox(null, { ...INPUT, expires: defaultRetrospectivaExpires("2610-11") });
      writeFileSync(join(snippetsDir, RETROSPECTIVA_BOX_FILENAME), box);
      assert.equal(readSnippetExpiry(box, "2026-11-30").status, "valid");
      assert.equal(readSnippetExpiry(box, "2026-12-01").status, "expired");
      const opts = {
        boxesCfg: { slot0: "", slot1: null, slot2: RETROSPECTIVA_BOX_FILENAME, slot3: null },
        autoCfg: auto([2]),
        editionsDir,
        postsDir,
        snippetsDir,
      };
      const orig = process.stderr.write.bind(process.stderr);
      (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
      try {
        const inside = resolveBoxesForEdition({ ...opts, aammdd: "261130" });
        assert.equal(inside.effective.slot2, RETROSPECTIVA_BOX_FILENAME);
        const after = resolveBoxesForEdition({ ...opts, aammdd: "261201" });
        assert.equal(after.effective.slot2, null, "box vencido não chega ao stitch");
        assert.equal(after.selection.find((s) => s.slot === 2)!.rejectReason, "expirado");
      } finally {
        process.stderr.write = orig;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runUpdateRetrospectivaBox + CLI (#13924)", () => {
  const base = {
    boxes_divulgacao: { slot1: "livros-divulgacao.md", slot2: "artigo-especial-apoiadores.md" },
    boxes_divulgacao_auto: { enabled: true, pinned_slots: [2] },
  };

  it("grava o expires recebido e avisa quando o box já nasceria vencido", () => {
    const dir = mkdtempSync(join(tmpdir(), "retro-run-13924-"));
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warns.push(String(m));
    try {
      const configPath = join(dir, "platform.config.json");
      writeFileSync(configPath, JSON.stringify(base, null, 2) + "\n");
      const snippetsFile = join(dir, "snippets", RETROSPECTIVA_BOX_FILENAME);
      const r = runUpdateRetrospectivaBox({
        cycle: "2610-11",
        temas: TEMAS,
        unpin: false,
        pin: true,
        force: false,
        dryRun: false,
        snippetsFile,
        configPath,
        cycleDir: join(dir, "cycle"),
        expires: "2026-11-30",
        now: new Date("2026-12-05T12:00:00Z"),
      });
      assert.equal(r.action, "updated");
      assert.equal(parseBoxHeaderField(readFileSync(snippetsFile, "utf8"), "expires"), "2026-11-30");
      assert.ok(warns.some((w) => /já passou/.test(w)), warns.join("\n"));
    } finally {
      console.warn = orig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI: default é o fim do mês de envio do ciclo; --expires sobrepõe", () => {
    const dir = mkdtempSync(join(tmpdir(), "retro-cli-13924-"));
    try {
      const cfg = join(dir, "platform.config.json");
      writeFileSync(cfg, JSON.stringify(base, null, 2) + "\n");
      const script = join(import.meta.dirname, "..", "scripts", "update-retrospectiva-box.ts");
      const run = (...args: string[]) =>
        spawnSync(
          process.execPath,
          ["--import", "tsx", script, "--temas", TEMAS.join("|"), ...args, "--config", cfg, "--snippets-file", join(dir, RETROSPECTIVA_BOX_FILENAME), "--dry-run"],
          { encoding: "utf8" },
        );
      const def = run("--cycle", "2612-01");
      assert.equal(def.status, 0, def.stderr);
      assert.match(def.stdout, /^expires: 2027-01-31$/m);
      const over = run("--cycle", "2612-01", "--expires", "2027-02-07");
      assert.equal(over.status, 0, over.stderr);
      assert.match(over.stdout, /^expires: 2027-02-07$/m);
      const bad = run("--cycle", "2612-01", "--expires", "31/01/2027");
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /AAAA-MM-DD/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
