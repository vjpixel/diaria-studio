/**
 * test/publish-youtube-10659.test.ts (#10659)
 *
 * Miolo puro do publisher do YouTube diário: metadados derivados do D1,
 * agendamento 06:00 BRT, request de `videos.insert`, estado (#573) e o plano
 * do dry-run. Nenhum teste toca rede nem a API.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  YOUTUBE_DESCRIPTION_MAX_BYTES,
  YOUTUBE_TAGS_MAX_CHARS,
  YOUTUBE_TITLE_MAX_CHARS,
  buildYouTubeDescription,
  buildYouTubeInsertRequest,
  buildYouTubeMetadata,
  buildYouTubeTags,
  buildYouTubeTitle,
  deriveEpisodeNumber,
  normalizeCategoryTag,
  resolveEffectiveVisibility,
  resolveYouTubeSchedule,
  stripInlineMarkdown,
  withYouTubeUtm,
  youtubeSubscribeCtaUrl,
  youtubeVideoFileName,
} from "../scripts/lib/diaria/youtube-video.ts";
import { resolveYouTubeState } from "../scripts/lib/publish-state.ts";
import { planYouTubePublish } from "../scripts/publish-youtube.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const D1 = {
  title: "IA ladra? O cofre que o modelo abriu",
  body: "Pesquisadores mostraram que um **agente** conseguiu [abrir o cofre](https://exemplo.com/a) sem senha.\n\nO teste usou 3 modelos.",
  url: "https://fonte.exemplo.com/artigo",
  category: "SEGURANÇA",
};

const REVIEWED_MD = `DESTAQUE 1 | SEGURANÇA
${D1.title}
${D1.url}

${D1.body}

Por que isso importa:
Porque sim.

---
DESTAQUE 2 | NEGÓCIOS
Outro título
https://outra.exemplo.com/b

Corpo do D2.

Por que isso importa:
Motivo.
`;

describe("metadados do vídeo (#10659 item 2)", () => {
  it("título é só o título do D1, sem sufixo (decisão do editor, 22/10/2026)", () => {
    assert.equal(buildYouTubeTitle(D1.title), D1.title);
    assert.ok(!/diar\.ia\.br comentada|\|/.test(buildYouTubeTitle(D1.title)));
  });

  it("título longo trunca com reticências e fica ≤ 100 chars", () => {
    const t = buildYouTubeTitle("x".repeat(200));
    assert.ok(Array.from(t).length <= YOUTUBE_TITLE_MAX_CHARS, `len=${t.length}`);
    assert.ok(t.includes("…"));
  });

  it("título e descrição nunca levam < ou > (a API recusa)", () => {
    const meta = buildYouTubeMetadata({
      aammdd: "261022",
      episode: 2,
      editionUrl: "https://diar.ia.br/p/x",
      d1: { ...D1, title: "A <tag> e o >", body: "a < b > c" },
    });
    assert.doesNotMatch(meta.title, /[<>]/);
    assert.doesNotMatch(meta.description, /[<>]/);
  });

  it("descrição = resumo sem markdown + edição com UTM, sem fonte (#10799) + CTA com UTM youtube", () => {
    const desc = buildYouTubeDescription({ aammdd: "261022", episode: 2, editionUrl: "https://diar.ia.br/p/ia-ladra", d1: D1 });
    assert.match(desc, /^Pesquisadores mostraram que um agente conseguiu abrir o cofre sem senha\./);
    assert.doesNotMatch(desc, /\*\*|\]\(/);
    assert.doesNotMatch(desc, /^Fonte:/m);
    assert.ok(!desc.includes(D1.url));
    assert.match(desc, /https:\/\/diar\.ia\.br\/p\/ia-ladra\?utm_source=youtube&utm_medium=video&utm_campaign=261022/);
    assert.ok(desc.includes("https://diar.ia.br/?utm_source=youtube&utm_medium=video&utm_campaign=261022"));
  });

  it("CTA bate exatamente com o usado no vídeo #1", () => {
    assert.equal(youtubeSubscribeCtaUrl("261021"), "https://diar.ia.br/?utm_source=youtube&utm_medium=video&utm_campaign=261021");
  });

  it("withYouTubeUtm sobrescreve UTM pré-existente em vez de duplicar", () => {
    const u = withYouTubeUtm("https://diar.ia.br/p/x?utm_source=email", "261022");
    assert.equal(new URL(u).searchParams.getAll("utm_source").join(","), "youtube");
  });

  it("descrição gigante é cortada abaixo de 5000 bytes preservando os links do fim", () => {
    const desc = buildYouTubeDescription({
      aammdd: "261022",
      episode: 2,
      editionUrl: "https://diar.ia.br/p/x",
      d1: { ...D1, body: "ação ".repeat(3000) },
    });
    assert.ok(Buffer.byteLength(desc, "utf8") <= YOUTUBE_DESCRIPTION_MAX_BYTES);
    assert.ok(desc.includes("utm_source=youtube&utm_medium=video&utm_campaign=261022"));
    assert.doesNotMatch(desc, /^Fonte:/m);
    assert.ok(!desc.includes(D1.url));
  });

  it("6 tags (decisão do editor), categoria do D1 entra em minúsculas, soma ≤ 500", () => {
    const tags = buildYouTubeTags("SEGURANÇA");
    assert.equal(tags.length, 6);
    assert.ok(tags.includes("segurança"));
    const total = tags.reduce((s, t) => s + t.length + (/\s/.test(t) ? 2 : 0), 0) + tags.length - 1;
    assert.ok(total <= YOUTUBE_TAGS_MAX_CHARS);
  });

  it("sem categoria (ou categoria repetida) ainda dá 6 tags", () => {
    assert.equal(buildYouTubeTags().length, 6);
    assert.equal(buildYouTubeTags("IA").length, 6);
  });

  it("tag da seção sai sem emoji (#10798: '🔬 PESQUISA' virava '🔬 pesquisa')", () => {
    const tags = buildYouTubeTags("🔬 PESQUISA");
    assert.equal(tags[5], "pesquisa");
    for (const t of tags) assert.doesNotMatch(t, /\p{Extended_Pictographic}/u);
    assert.equal(normalizeCategoryTag("⚠️ SEGURANÇA"), "segurança");
    assert.equal(normalizeCategoryTag("  👩🏽‍💻  USE   MELHOR 🔬 "), "use melhor");
    // Só emoji: vira vazio e cai no fallback "newsletter".
    assert.equal(buildYouTubeTags("🔬")[5], "newsletter");
  });

  it("dry-run com header 'DESTAQUE 1 | 🔬 PESQUISA' gera tag sem emoji (#10798)", () => {
    const md = REVIEWED_MD.replace("DESTAQUE 1 | SEGURANÇA", "DESTAQUE 1 | 🔬 PESQUISA");
    const plan = planYouTubePublish({
      aammdd: "261022",
      reviewedMd: md,
      now: new Date("2026-10-21T23:00:00Z"),
      video: { path: "/x/v.mp4", exists: true, sizeBytes: 1 },
      thumb: { path: "/x/t.jpg", exists: true },
    });
    assert.ok(plan.metadata.tags.includes("pesquisa"), JSON.stringify(plan.metadata.tags));
    assert.equal(plan.metadata.tags.some((t) => /\p{Extended_Pictographic}/u.test(t)), false);
  });

  it("stripInlineMarkdown remove negrito, itálico e links", () => {
    assert.equal(stripInlineMarkdown("um **b** e *i* e [l](https://x.com/a_(b))"), "um b e i e l");
  });

  it("stripInlineMarkdown preserva asterisco literal colado em alfanumérico", () => {
    assert.equal(stripInlineMarkdown("custo 2*3*4 vezes"), "custo 2*3*4 vezes");
    assert.equal(stripInlineMarkdown("a*b e c*d"), "a*b e c*d");
    assert.equal(stripInlineMarkdown("*início* e (*meio*)."), "início e (meio).");
  });

  it("episódio pela cadência diária: 261021 = #1, 261022 = #2, virada de mês ok", () => {
    assert.equal(deriveEpisodeNumber("261021"), 1);
    assert.equal(deriveEpisodeNumber("261022"), 2);
    assert.equal(deriveEpisodeNumber("261101"), 12);
    assert.throws(() => deriveEpisodeNumber("261020"), /anterior/);
  });

  it("buildYouTubeMetadata recusa episódio inválido", () => {
    assert.throws(() => buildYouTubeMetadata({ aammdd: "261022", episode: 0, editionUrl: "https://diar.ia.br/", d1: D1 }));
  });

  it("convenção do arquivo de vídeo por edição", () => {
    assert.equal(youtubeVideoFileName("261022"), "diaria-comentada-261022.mp4");
  });
});

describe("agendamento publishAt (#10659 item 1/6)", () => {
  it("antes das 06:00 BRT do dia → agendado 09:00Z, privado (publishAt exige private)", () => {
    const s = resolveYouTubeSchedule("261022", new Date("2026-10-21T23:00:00Z"));
    assert.equal(s.mode, "scheduled");
    assert.equal(s.publishAt, "2026-10-22T09:00:00.000Z");
    assert.equal(s.privacyStatus, "private");
  });

  it("depois das 06:00 BRT → publica na hora com premissa registrada", () => {
    const s = resolveYouTubeSchedule("261022", new Date("2026-10-22T15:00:00Z"));
    assert.equal(s.mode, "immediate");
    assert.equal(s.publishAt, null);
    assert.equal(s.privacyStatus, "public");
    assert.match(s.premise, /já passou/);
  });

  it("--publish-at explícito vence o default", () => {
    const s = resolveYouTubeSchedule("261022", new Date("2026-10-21T00:00:00Z"), "2026-10-22T12:00:00Z");
    assert.equal(s.publishAt, "2026-10-22T12:00:00.000Z");
  });

  it("--publish-at inválido lança", () => {
    assert.throws(() => resolveYouTubeSchedule("261022", new Date(), "amanhã"));
  });
});

describe("request de videos.insert", () => {
  const meta = buildYouTubeMetadata({ aammdd: "261022", episode: 2, editionUrl: "https://diar.ia.br/p/x", d1: D1 });

  it("agendado: private + publishAt + não-infantil + pt-BR + resumable", () => {
    const req = buildYouTubeInsertRequest(meta, resolveYouTubeSchedule("261022", new Date("2026-10-21T23:00:00Z")), {
      contentLength: 1234,
    });
    assert.match(req.url, /uploadType=resumable/);
    assert.equal(req.body.status.privacyStatus, "private");
    assert.equal(req.body.status.publishAt, "2026-10-22T09:00:00.000Z");
    assert.equal(req.body.status.selfDeclaredMadeForKids, false);
    assert.equal(req.body.snippet.defaultLanguage, "pt-BR");
    assert.equal(req.headers["X-Upload-Content-Length"], "1234");
    assert.equal(req.headers["X-Upload-Content-Type"], "video/mp4");
  });

  it("imediato: public sem publishAt; nunca carrega Authorization", () => {
    const req = buildYouTubeInsertRequest(meta, resolveYouTubeSchedule("261022", new Date("2026-10-22T15:00:00Z")));
    assert.equal(req.body.status.privacyStatus, "public");
    assert.equal("publishAt" in req.body.status, false);
    assert.equal("X-Upload-Content-Length" in req.headers, false);
    assert.equal(Object.keys(req.headers).some((h) => h.toLowerCase() === "authorization"), false);
  });
});

describe("resolveYouTubeState (#10659 item 5, #573)", () => {
  const NOW = new Date("2026-10-22T08:00:00Z");
  it("public → published", () => {
    assert.equal(resolveYouTubeState({ status: { privacyStatus: "public", uploadStatus: "processed" } }, NOW), "published");
  });
  it("private + publishAt futuro → scheduled", () => {
    assert.equal(resolveYouTubeState({ status: { privacyStatus: "private", publishAt: "2026-10-22T09:00:00Z" } }, NOW), "scheduled");
  });
  it("private sem publishAt (projeto GCP não auditado) → draft, nunca published", () => {
    assert.equal(resolveYouTubeState({ status: { privacyStatus: "private", uploadStatus: "uploaded" } }, NOW), "draft");
  });
  it("private + publishAt passado → unknown (drift)", () => {
    assert.equal(resolveYouTubeState({ status: { privacyStatus: "private", publishAt: "2026-10-22T07:00:00Z" } }, NOW), "unknown");
  });
  it("upload failed/rejected/deleted → unknown mesmo se public", () => {
    for (const u of ["failed", "rejected", "deleted"]) {
      assert.equal(resolveYouTubeState({ status: { privacyStatus: "public", uploadStatus: u } }, NOW), "unknown");
    }
  });
  it("unlisted, publishAt malformado e status ausente → unknown", () => {
    assert.equal(resolveYouTubeState({ status: { privacyStatus: "unlisted" } }, NOW), "unknown");
    assert.equal(resolveYouTubeState({ status: { privacyStatus: "private", publishAt: "xx" } }, NOW), "unknown");
    assert.equal(resolveYouTubeState({}, NOW), "unknown");
    assert.equal(resolveYouTubeState({ status: null }, NOW), "unknown");
  });
});

describe("planYouTubePublish (dry-run)", () => {
  const base = {
    aammdd: "261022",
    reviewedMd: REVIEWED_MD,
    now: new Date("2026-10-21T23:00:00Z"),
    video: { path: "/x/diaria-comentada-261022.mp4", exists: true, sizeBytes: 99 },
    thumb: { path: "/x/04-youtube-thumb.jpg", exists: true },
  };

  it("deriva tudo do D1 de 02-reviewed.md e registra premissas de episódio e link", () => {
    const plan = planYouTubePublish(base);
    assert.equal(plan.episode, 2);
    assert.equal(plan.metadata.title, D1.title);
    assert.doesNotMatch(plan.request.body.snippet.description, /^Fonte:/m);
    assert.ok(!plan.request.body.snippet.description.includes(D1.url));
    assert.equal(plan.schedule.mode, "scheduled");
    assert.ok(plan.premises.some((p) => /cadência diária/.test(p)));
    assert.ok(plan.premises.some((p) => /slug do título/.test(p)));
    // Projeto GCP ainda sem auditoria: único aviso é o rebaixamento para private.
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /sem auditoria/);
    assert.ok(plan.thumbnail?.endpoint.includes("thumbnails/set"));
  });

  it("--episode e --edition-url explícitos não geram premissa", () => {
    const plan = planYouTubePublish({ ...base, episode: 7, editionUrl: "https://diar.ia.br/p/real" });
    assert.equal(plan.episode, 7);
    assert.ok(plan.metadata.description.includes("https://diar.ia.br/p/real?utm_source=youtube"));
    assert.equal(plan.premises.some((p) => /cadência|slug/.test(p)), false);
  });

  it("vídeo e capa ausentes viram aviso (fail-soft), não erro", () => {
    const plan = planYouTubePublish({
      ...base,
      video: { path: "/x/v.mp4", exists: false, sizeBytes: null },
      thumb: { path: "/x/t.jpg", exists: false },
    });
    assert.equal(plan.warnings.filter((w) => /ausente/.test(w)).length, 2);
    assert.equal(plan.thumbnail, null);
  });

  it("modo 'na hora' sem auditoria do GCP: request pede public, mas o efetivo é private + aviso", () => {
    const plan = planYouTubePublish({ ...base, now: new Date("2026-10-22T12:00:00Z") });
    assert.equal(plan.schedule.mode, "immediate");
    assert.equal(plan.request.body.status.privacyStatus, "public");
    assert.deepEqual(plan.effective, { privacyStatus: "private", publishAt: null, auditBlocked: true });
    assert.ok(plan.warnings.some((w) => /publicação na hora \(public\)/.test(w) && /private/.test(w)));
  });

  it("projeto auditado: efetivo segue o plano e não há aviso de auditoria", () => {
    const now = planYouTubePublish({ ...base, now: new Date("2026-10-22T12:00:00Z"), projectAudited: true });
    assert.deepEqual(now.effective, { privacyStatus: "public", publishAt: null, auditBlocked: false });
    const sched = planYouTubePublish({ ...base, projectAudited: true });
    assert.equal(sched.effective.publishAt, sched.schedule.publishAt);
    assert.equal(sched.warnings.length, 0);
  });

  it("resolveEffectiveVisibility sem auditoria rebaixa também o agendado", () => {
    const s = resolveYouTubeSchedule("261022", new Date("2026-10-21T23:00:00Z"));
    assert.deepEqual(resolveEffectiveVisibility(s, false), { privacyStatus: "private", publishAt: null, auditBlocked: true });
  });

  it("sem DESTAQUE 1 lança", () => {
    assert.throws(() => planYouTubePublish({ ...base, reviewedMd: "nada aqui" }), /DESTAQUE 1/);
  });
});

describe("guardas do CLI e da skill", () => {
  const cli = readFileSync(resolve(ROOT, "scripts/publish-youtube.ts"), "utf8");

  it("CLI tem guard de import (isMainModule) e não chama a API (sem fetch)", () => {
    assert.match(cli, /if \(isMainModule\(import\.meta\.url\)\)/);
    assert.doesNotMatch(cli, /\bfetch\(/);
    assert.doesNotMatch(cli, /process\.exit\(/);
  });

  it("sem --dry-run o CLI recusa (exit 2) antes de ler a edição ou imprimir plano", () => {
    // Executa o CLI de verdade (o caminho sem --dry-run não chama API nenhuma):
    // com uma edição VÁLIDA no disco, só o guard explica o exit 2 sem stdout.
    const dir = mkdtempSync(join(tmpdir(), "publish-youtube-10659-"));
    try {
      writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_MD);
      const script = resolve(ROOT, "scripts/publish-youtube.ts");
      const r = spawnSync(process.execPath, ["--import", "tsx", script, "261022", "--edition-dir", dir], {
        encoding: "utf8",
        cwd: ROOT,
      });
      assert.equal(r.status, 2, r.stderr);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /--dry-run/);
      // Controle: a mesma edição com --dry-run produz o plano (exit 0).
      const ok = spawnSync(process.execPath, ["--import", "tsx", script, "261022", "--edition-dir", dir, "--dry-run"], {
        encoding: "utf8",
        cwd: ROOT,
      });
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /"dry_run": true/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skill /diaria-youtube existe e usa o publisher com --dry-run", () => {
    const skill = readFileSync(resolve(ROOT, ".claude/skills/diaria-youtube/SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: diaria-youtube\n/);
    assert.match(skill, /scripts\/publish-youtube\.ts \{AAMMDD\} --dry-run/);
    assert.match(skill, /#10659/);
  });
});
