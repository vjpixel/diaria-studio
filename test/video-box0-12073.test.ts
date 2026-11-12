/**
 * test/video-box0-12073.test.ts (#12073)
 *
 * Box do vídeo no slot 0 da newsletter: 2 vezes por semana (terça e quinta),
 * cede a vez a outro aviso de slot 0 e passa para a próxima edição da semana
 * com vídeo; edição sem vídeo nunca leva o box (nem link pro canal).
 *
 * Semana usada: segunda 261102 ... sexta 261106.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVideoBox0Href,
  buildVideoBox0Markdown,
  countVideoBox0Shown,
  decideVideoBox0,
  editionWeekday,
  videoBox0Quota,
  weekEditionsBefore,
  VIDEO_BOX0_CATEGORIA,
} from "../scripts/lib/diaria/video-box0.ts";
import { extractContent, resolveVideoBox0, BOX0_SENTINEL } from "../scripts/lib/newsletter-parse.ts";
import { renderHTML } from "../scripts/lib/newsletter-render-html.ts";

const EIA = `**É IA?**

Foto teste. [Autor](https://example.com/a) / CC.

Resultado da última edição: 40% das pessoas acertaram.
`;

function d(n: number): string {
  return `**DESTAQUE ${n} | 💼 MERCADO**

**[Título D${n}](https://example.com/d${n})**

Corpo do destaque ${n}.

Por que isso importa:

Why do D${n}.
`;
}

function reviewed(box0?: string, callout?: string): string {
  const box = box0 ? `${BOX0_SENTINEL}\n${box0}\n\n---\n\n` : "";
  const intro = callout ? `${callout}\n\n---\n\n` : "";
  return `TÍTULO: Edição de teste

---

Olá! Eu sou o [Pixel](https://example.com/pixel). Hoje li 80 notícias e selecionei os 12 mais relevantes.

---

${intro}${box}${d(1)}

---

${d(2)}

---

${d(3)}

---

${EIA}
`;
}

const ID = "abcdefghijk";

interface DayFixture {
  video?: boolean;
  box0?: string;
  callout?: string;
  noVideo?: boolean;
  record?: Record<string, unknown>;
}

function withWeek<T>(days: Record<string, DayFixture>, fn: (dirOf: (aammdd: string) => string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "video-box0-12073-"));
  const dirOf = (aammdd: string) => join(root, aammdd.slice(0, 4), aammdd);
  try {
    for (const [aammdd, f] of Object.entries(days)) {
      const dir = dirOf(aammdd);
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "02-reviewed.md"), reviewed(f.box0, f.callout), "utf8");
      writeFileSync(join(dir, "01-eia.md"), EIA, "utf8");
      if (f.video) writeFileSync(join(dir, "_internal", "05-video-url.txt"), `https://youtu.be/${ID}\n`);
      if (f.noVideo) writeFileSync(join(dir, "_internal", "no-video.json"), "{}");
      if (f.record) writeFileSync(join(dir, "_internal", "05-youtube-published.json"), JSON.stringify(f.record));
    }
    return fn(dirOf);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const APOIO = "**Apoie a diar.ia.br**\n\nTexto do aviso de apoio.\n\n[Apoiar](https://apoia.se/diaria)";

describe("#12073 — cota do box do vídeo (puro)", () => {
  it("dias da semana e cota cumulativa: terça abre 1, quinta abre a 2ª", () => {
    assert.equal(editionWeekday("261103"), 2);
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6].map(videoBox0Quota),
      [2, 0, 1, 1, 2, 2, 2],
      "domingo fecha a semana com as 2 vagas; segunda não tem vaga",
    );
    assert.deepEqual(weekEditionsBefore("261105"), ["261102", "261103", "261104"]);
    assert.deepEqual(weekEditionsBefore("261102"), []);
    assert.deepEqual(weekEditionsBefore("261108"), ["261102", "261103", "261104", "261105", "261106", "261107"]);
  });

  it("sem vídeo ou com slot 0 ocupado nunca leva", () => {
    assert.equal(decideVideoBox0(2, { hasVideo: false, slot0Busy: false }, 0), false);
    assert.equal(decideVideoBox0(2, { hasVideo: true, slot0Busy: true }, 0), false);
    assert.equal(decideVideoBox0(2, { hasVideo: true, slot0Busy: false }, 0), true);
    assert.equal(decideVideoBox0(1, { hasVideo: true, slot0Busy: false }, 0), false, "segunda: sem vaga");
  });

  it("terça que cede a vez passa para a quarta; a quinta segue com a sua", () => {
    const v = { hasVideo: true, slot0Busy: false };
    const busy = { hasVideo: true, slot0Busy: true };
    const week = [
      { weekday: 1, state: v },
      { weekday: 2, state: busy },
      { weekday: 3, state: v },
      { weekday: 4, state: v },
    ];
    assert.equal(countVideoBox0Shown(week.slice(0, 3)), 1, "quarta leva o box que a terça cedeu");
    assert.equal(countVideoBox0Shown(week), 2);
    assert.equal(decideVideoBox0(5, v, countVideoBox0Shown(week)), false, "sexta: cota cheia");
  });

  it("markdown e UTM próprias do box", () => {
    const href = buildVideoBox0Href(`https://youtu.be/${ID}`, "261103");
    const u = new URL(href);
    assert.equal(u.searchParams.get("utm_campaign"), "video-box0-261103");
    assert.equal(u.searchParams.get("utm_source"), "newsletter");
    assert.equal(u.searchParams.get("utm_medium"), "email");
    const md = buildVideoBox0Markdown({ title: "Título **do** vídeo", href });
    assert.match(md, /^\*\*Título do vídeo\*\*\n\n/);
    assert.ok(md.includes(`[Assista no YouTube](${href})`));
    assert.ok(!/[→←]/.test(md), "sem seta em copy ao leitor (#9721)");
    assert.match(buildVideoBox0Markdown({ title: null, href }), /^\*\*O vídeo de hoje\*\*/);
  });
});

describe("#12073 — box do vídeo no render", () => {
  it("terça com vídeo e slot 0 livre: box no topo, título do registro, link pro vídeo", () => {
    withWeek(
      { "261103": { video: true, record: { videoId: ID, title: "Vídeo da terça", uploadedAt: "2026-11-03T02:00:00Z" } } },
      (dirOf) => {
        const content = extractContent(dirOf("261103"));
        assert.match(content.boxDivulgacao0 ?? "", /\*\*Vídeo da terça\*\*/);
        assert.equal(content.boxDivulgacao0Categoria, VIDEO_BOX0_CATEGORIA);
        const html = renderHTML(content);
        assert.ok(html.includes("utm_campaign=video-box0-261103"), "link do box com a UTM do box");
        assert.ok(html.indexOf("video-box0-261103") < html.indexOf("Título D1"), "box antes do D1");
      },
    );
  });

  it("edição sem vídeo (ou marcada sem vídeo) não leva box, nem link pro canal", () => {
    withWeek({ "261103": {}, "261105": { video: true, noVideo: true } }, (dirOf) => {
      for (const day of ["261103", "261105"]) {
        const content = extractContent(dirOf(day));
        assert.equal(content.boxDivulgacao0, null, `${day} sem box`);
        assert.ok(!renderHTML(content).includes("video-box0"), `${day} sem link do box`);
      }
    });
  });

  it("aviso de apoio no slot 0 vence: a terça cede e a quarta leva o box", () => {
    withWeek(
      { "261103": { video: true, box0: APOIO }, "261104": { video: true } },
      (dirOf) => {
        const tue = extractContent(dirOf("261103"));
        assert.match(tue.boxDivulgacao0 ?? "", /Apoie a diar\.ia\.br/);
        assert.ok(!renderHTML(tue).includes("video-box0"));
        assert.match(resolveVideoBox0(dirOf("261104"), false) ?? "", /video-box0-261104/);
      },
    );
  });

  it("marcador _internal/no-video-box0.json tira o box só desta edição", () => {
    withWeek({ "261103": { video: true }, "261105": { video: true } }, (dirOf) => {
      assert.ok(resolveVideoBox0(dirOf("261103"), false), "sem marcador a terça leva o box");
      writeFileSync(join(dirOf("261103"), "_internal", "no-video-box0.json"), "{}");
      assert.equal(resolveVideoBox0(dirOf("261103"), false), null);
      assert.ok(resolveVideoBox0(dirOf("261105"), false), "outra edição segue com a cota");
    });
  });

  it("terça com marcador e sem registro: a vaga passa para a quarta (#12899)", () => {
    withWeek({ "261103": { video: true }, "261104": { video: true } }, (dirOf) => {
      writeFileSync(join(dirOf("261103"), "_internal", "no-video-box0.json"), "{}");
      assert.equal(resolveVideoBox0(dirOf("261103"), false), null);
      assert.ok(resolveVideoBox0(dirOf("261104"), false), "a quarta leva o box que a terça cedeu");
    });
  });

  it("callout de sorteio no topo também ocupa o slot: a terça cede", () => {
    const callout = "**🎥 Hoje às 19h tem sorteio ao vivo: [participe](https://example.com/live).**";
    withWeek({ "261103": { video: true, callout }, "261104": { video: true } }, (dirOf) => {
      assert.equal(extractContent(dirOf("261103")).boxDivulgacao0, null);
      assert.ok(resolveVideoBox0(dirOf("261104"), false), "a quarta leva o box que a terça cedeu");
    });
  });

  it("quarta depois de uma terça que levou o box: fica sem; segunda nunca leva", () => {
    withWeek(
      { "261102": { video: true }, "261103": { video: true }, "261104": { video: true }, "261105": { video: true } },
      (dirOf) => {
        assert.equal(resolveVideoBox0(dirOf("261102"), false), null);
        assert.ok(resolveVideoBox0(dirOf("261103"), false));
        assert.equal(resolveVideoBox0(dirOf("261104"), false), null);
        assert.ok(resolveVideoBox0(dirOf("261105"), false));
        assert.equal(resolveVideoBox0(dirOf("261105"), true), null, "slot 0 ocupado no próprio dia");
      },
    );
  });

  it("diretório fora do layout AAMM/AAMMDD: semana vazia, decide só pelo dia", () => {
    const root = mkdtempSync(join(tmpdir(), "video-box0-flat-"));
    const dir = join(root, "261103");
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "05-video-url.txt"), `https://youtu.be/${ID}\n`);
      assert.ok(resolveVideoBox0(dir, false));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
