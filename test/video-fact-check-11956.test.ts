/**
 * #11956: fact-check da fala do vídeo antes do Gate 2 da /diaria-video-montagem.
 * Na 261103 o roteiro gravado levou 4 erros graves (BrowseComp atribuído ao
 * Kimi, modelo inexistente, "a Mistral e a IBM usam a mesma definição", um 4º
 * ponto sem fonte) que só saíram porque o editor pediu a checagem à mão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedItem, SequencePlan, SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";
import {
  factCheckItems,
  factCheckItemsSha256,
  factCheckSection,
  locateClaim,
  parseVideoFactCheck,
  type VideoFactCheck,
} from "../scripts/lib/diaria/video-fact-check.ts";
import { SUBCOMMANDS } from "../scripts/video-montagem.ts";

const ROOT = join(import.meta.dirname, "..");

const item = (text: string, start: number, end: number, extra: Partial<ResolvedItem> = {}): ResolvedItem =>
  ({ text, interval: { start, end }, words: [], lastWordEnd: end, holdLimit: end + 1, how: "explicit", ...extra }) as ResolvedItem;

const spec = (target: SequenceSpec["target"], name: string, w: number, h: number, order: SequenceSpec["order"]): SequenceSpec =>
  ({ target, name, width: w, height: h, order, scales: [100, 110] }) as SequenceSpec;

const plan = (s: SequenceSpec, durationFrames: number): SequencePlan => ({ spec: s, clips: [], durationFrames, script: "", missingBlocks: [], dropped: [] });

const resolved: Partial<Record<"resumo" | "resumo_curto" | "comentario", ResolvedItem[]>> = {
  resumo: [item("A Mistral lançou o Medium 4, com 62% no BrowseComp.", 10, 16)],
  resumo_curto: [item("A Mistral lançou o Medium 4.", 40, 42)],
  comentario: [
    item("O Kimi lidera o BrowseComp.", 20, 23, { heard: "O Kimi lidera o BrowseComp com folga." }),
    item("A Mistral e a IBM usam a mesma definição de IA soberana.", 24, 29),
    item("Só no horizontal.", 30, 31, { targets: ["youtube"] }),
  ],
};
const H = plan(spec("youtube", "Diaria comentada_Youtube_V1", 1920, 1080, ["resumo", "comentario"]), 3000);
const V = plan(spec("outras-redes", "Diaria comentada_Vertical_V1", 1080, 1920, ["resumo_curto", "comentario"]), 2400);

describe("#11956: itens da fala que vão ao ar", () => {
  it("união das versões, a mais longa primeiro, cada item uma vez, com as versões dele", () => {
    const items = factCheckItems([V, H], resolved);
    assert.deepEqual(items.map((i) => i.id), ["resumo[0]", "comentario[0]", "comentario[1]", "comentario[2]", "resumo_curto[0]"]);
    assert.deepEqual(items.find((i) => i.id === "comentario[1]")!.versions, ["Horizontal YouTube 1920x1080", "Vertical 1080x1920"]);
    assert.deepEqual(items.find((i) => i.id === "comentario[2]")!.versions, ["Horizontal YouTube 1920x1080"], "targets respeitado");
  });

  it("a fala ouvida que difere do pedido vai junto: é ela que vai ao ar", () => {
    const it0 = factCheckItems([H], resolved).find((i) => i.id === "comentario[0]")!;
    assert.equal(it0.heard, "O Kimi lidera o BrowseComp com folga.");
  });

  it("o hash muda com o texto, não com o tempo no bruto", () => {
    const a = factCheckItems([H], resolved);
    const moved = factCheckItems([H], { ...resolved, resumo: [item(resolved.resumo![0].text, 11, 17)] });
    const edited = factCheckItems([H], { ...resolved, resumo: [item("A Mistral lançou o Medium 4.", 10, 16)] });
    assert.equal(factCheckItemsSha256(moved), factCheckItemsSha256(a));
    assert.notEqual(factCheckItemsSha256(edited), factCheckItemsSha256(a));
  });
});

describe("#11956: achados no Doc do Gate 2", () => {
  const items = factCheckItems([H, V], resolved);
  const fc = (claims: VideoFactCheck["claims"], sha = factCheckItemsSha256(items)): VideoFactCheck => ({ mode: "video", edition: "261103", items_sha256: sha, claims });

  it("achado grave sai com o bloco, o trecho do bruto e a proposta de corte", () => {
    const s = factCheckSection(
      fc([
        { item: "comentario[0]", claim: "O Kimi lidera o BrowseComp", verdict: "DIVERGENT", note: "o BrowseComp citado é do Medium 4", suggested_fix: "O Medium 4 lidera o BrowseComp" },
        { item: "comentario[1]", claim: "A Mistral e a IBM usam a mesma definição", verdict: "NOT_FOUND_IN_SOURCE", source_url: "https://mistral.ai/news/x" },
        { item: "resumo[0]", claim: "62% no BrowseComp", verdict: "SUSTAINED" },
      ]),
      items,
    );
    const md = s.lines.join("\n");
    assert.equal(s.graves, 2);
    assert.match(md, /Comentário \[0\].*O Kimi lidera o BrowseComp.*00:20\.0–00:23\.0.*DIVERGENT.*cortar o trecho.*regravar com "O Medium 4 lidera o BrowseComp"/);
    assert.match(md, /Comentário \[1\].*00:24\.0–00:29\.0.*NOT_FOUND_IN_SOURCE.*mistral\.ai.*"skip"/);
    assert.match(md, /2 achado\(s\) grave\(s\) em aberto, 0 não verificado\(s\), 1 sustentado/);
  });

  it("trecho que o editor já cortou do roteiro vira resolvido", () => {
    const cut = factCheckItems([H, V], { ...resolved, comentario: resolved.comentario!.slice(0, 1) });
    const s = factCheckSection(fc([{ item: "comentario[1]", claim: "A Mistral e a IBM usam a mesma definição", verdict: "NOT_FOUND_IN_SOURCE" }]), cut);
    assert.equal(s.graves, 0);
    assert.match(s.lines.join("\n"), /resolvido: o trecho saiu do roteiro/);
    assert.equal(s.stale, true, "o roteiro mudou depois do fact-check");
    assert.match(s.lines.join("\n"), /o roteiro mudou depois do fact-check/);
  });

  it("o achado segue o trecho mesmo com o índice do item mudado", () => {
    const shifted = factCheckItems([H], { ...resolved, comentario: [item("Frase nova.", 18, 19), ...resolved.comentario!] });
    const it = locateClaim({ item: "comentario[1]", claim: "a mistral e a IBM usam", verdict: "DIVERGENT" }, shifted);
    assert.equal(it?.id, "comentario[2]");
  });

  it("sem fact-check.json o Doc avisa que o passo não rodou", () => {
    const s = factCheckSection(null, items);
    assert.match(s.lines.join("\n"), /fact-check não rodou/);
  });

  it("fonte fora do ar aparece como não verificado, sem contar como grave", () => {
    const s = factCheckSection(fc([{ item: "resumo[0]", claim: "62% no BrowseComp", verdict: "SOURCE_UNREACHABLE", source_url: "https://x" }]), items);
    assert.equal(s.graves, 0);
    assert.match(s.lines.join("\n"), /não verificado.*62% no BrowseComp/);
  });

  it("parseVideoFactCheck recusa formato errado com o campo", () => {
    assert.throws(() => parseVideoFactCheck({ mode: "daily", items_sha256: "x", claims: [] }), /mode/);
    assert.throws(() => parseVideoFactCheck({ mode: "video", claims: [] }), /items_sha256/);
    assert.throws(() => parseVideoFactCheck({ mode: "video", items_sha256: "x", claims: [{ item: "a", claim: "b", verdict: "OK" }] }), /verdict/);
    assert.equal(parseVideoFactCheck({ mode: "video", edition: "261103", items_sha256: "x", claims: [] }).claims.length, 0);
  });
});

describe("#11956: o passo existe na skill, no CLI e no agent", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  it("subcomando fact-check-input registrado", () => {
    assert.ok((SUBCOMMANDS as readonly string[]).includes("fact-check-input"));
  });
  it("a skill roda o fact-check entre o roteiro e o Gate 2", () => {
    const skill = read(".claude/skills/diaria-video-montagem/SKILL.md");
    const i = skill.indexOf("scripts/video-montagem.ts fact-check-input");
    assert.ok(i > skill.indexOf("scripts/video-montagem.ts roteiro"), "depois do roteiro");
    assert.ok(i < skill.indexOf("## Passo 4"), "antes do XML (o Gate 2 é no Passo 3)");
    assert.match(skill, /mode: "video"/);
  });
  it("o fact-checker documenta o mode video (input, output, fontes do D1)", () => {
    const agent = read(".claude/agents/fact-checker.md");
    assert.match(agent, /## Modo vídeo/);
    assert.match(agent, /fact-check-input\.json/);
    assert.match(agent, /fact-check-sources/);
  });
});
