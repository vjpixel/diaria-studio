/**
 * #12833 — `test/d1-invite-mobile-size-12747.test.ts` morreu calado no CI no
 * meio do 1º teste que mede o convite com o librsvg (`'test failed'` em 1:1,
 * sem erro de JS: o node:test imprime isso quando o processo do arquivo morre
 * por sinal). A medição rodava as linhas em paralelo, duas threads do libuv
 * fazendo o 1º raster de texto (pango + fontconfig) ao mesmo tempo. O fix põe
 * todo raster de texto do processo numa fila de um lugar só.
 *
 * Regressão: a fila nunca deixa dois renders se sobreporem, erro não trava a
 * fila, e `measureInviteText` passa por ela (inclusive com chamadas
 * concorrentes, que dão o mesmo resultado das sequenciais).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { measureInviteText, serializeTextRender } from "../scripts/lib/diaria/d1-play-image.ts";
import { D1_INVITE_FONT_FAMILY } from "../scripts/lib/diaria/d1-video-hero.ts";

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("#12833 — raster de texto do convite em fila", () => {
  it("renders disparados juntos rodam um de cada vez, na ordem de chegada", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const jobs = [30, 5, 20, 1, 10].map((ms, i) =>
      serializeTextRender(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick(ms);
        order.push(i);
        inFlight--;
        return i;
      }),
    );
    assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4]);
    assert.equal(maxInFlight, 1, "dois renders de texto ao mesmo tempo");
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  it("render que falha propaga o erro e não trava os seguintes", async () => {
    const failed = serializeTextRender(async () => {
      throw new Error("raster quebrou");
    });
    const next = serializeTextRender(async () => "seguiu");
    await assert.rejects(failed, /raster quebrou/);
    assert.equal(await next, "seguiu");
  });

  it("measureInviteText espera a fila: não mede enquanto outro raster de texto está em curso", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let blockerStarted = false;
    const blocker = serializeTextRender(async () => {
      blockerStarted = true;
      await gate;
    });
    let measured = false;
    const measuring = measureInviteText(1600).then((m) => {
      measured = true;
      return m;
    });
    await tick(150);
    assert.ok(blockerStarted);
    assert.equal(measured, false, "a medição furou a fila e rodou junto com outro raster");
    release();
    await blocker;
    const m = await measuring;
    assert.ok(m.textW > 0 && m.ascent > 0 && m.descent >= 0);
  });

  it("chamadas concorrentes (fonte real e de reserva) dão o mesmo resultado das sequenciais", async () => {
    const families = [D1_INVITE_FONT_FAMILY, "NoSuchFontXYZ"];
    const sequential = [];
    for (const f of families) sequential.push(await measureInviteText(1600, f));
    const concurrent = await Promise.all(families.map((f) => measureInviteText(1600, f)));
    assert.deepEqual(concurrent, sequential);
  });
});
