/**
 * #11223: diagnóstico do ambiente da capa do vídeo do dia, para rodar o
 * `/diaria-publica-video` no `300` sem o Neo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assessVideoEnv,
  formatVideoEnvReport,
  rembgSetupCommand,
  rembgVenvPython,
  type VideoEnvProbes,
} from "../scripts/lib/diaria/video-env-check.ts";

const allOk: VideoEnvProbes = { ffmpeg: { ok: true }, codex: { ok: true, detail: "codex-cli 0.159.1" }, georgia: { ok: true }, rembg: { ok: true } };

describe("#11223 video-env-check", () => {
  it("tudo ok: a capa sai nesta máquina, sem instrução de setup", () => {
    const r = assessVideoEnv(allOk, "linux");
    assert.equal(r.coverReady, true);
    assert.deepEqual(r.missing, []);
    assert.ok(r.items.every((i) => i.fix === null));
    assert.match(formatVideoEnvReport(r), /A capa horizontal sai nesta máquina/);
  });

  it("só o rembg faltando (o estado do 300 em 27/10/2026): aponta o setup Linux e o passo bloqueado", () => {
    const r = assessVideoEnv({ ...allOk, rembg: { ok: false, detail: "venv ausente" } }, "linux");
    assert.equal(r.coverReady, false);
    assert.deepEqual(r.missing, ["rembg"]);
    const rembg = r.items.find((i) => i.id === "rembg")!;
    assert.match(rembg.blocks, /Passo A2\.3/);
    assert.match(rembg.fix!, /uv python install 3\.11\.9/);
    assert.match(rembg.fix!, /setup-rembg\.py/);
    const text = formatVideoEnvReport(r);
    assert.match(text, /\[falta\] rembg \(venv ausente\)/);
    assert.match(text, /O resto do \/diaria-publica-video segue/);
  });

  it("Georgia no Linux: instrução de copiar do Neo, nunca versionar a fonte", () => {
    const r = assessVideoEnv({ ...allOk, georgia: { ok: false } }, "linux");
    assert.match(r.items.find((i) => i.id === "georgia")!.fix!, /fc-cache/);
    assert.match(r.items.find((i) => i.id === "georgia")!.fix!, /nunca versionar/);
  });

  it("Codex: a instrução exige a conta ChatGPT, nunca API key (#5608/#9088)", () => {
    const r = assessVideoEnv({ ...allOk, codex: { ok: false } }, "linux");
    assert.match(r.items.find((i) => i.id === "codex")!.fix!, /conta ChatGPT, nunca API key/);
  });

  it("layout do venv e comando de setup batem com scripts/setup-rembg.py por plataforma", () => {
    assert.equal(rembgVenvPython("win32"), ".venv-rembg/Scripts/python.exe");
    assert.equal(rembgVenvPython("linux"), ".venv-rembg/bin/python");
    assert.equal(rembgSetupCommand("win32"), "py -3.11 scripts/setup-rembg.py");
    const py = readFileSync(new URL("../scripts/setup-rembg.py", import.meta.url), "utf8");
    assert.match(py, /VENV \/ "Scripts" \/ "python\.exe" if sys\.platform == "win32" else VENV \/ "bin" \/ "python"/);
    assert.match(py, /uv python install 3\.11\.9/, "o HELP do setup cita o mesmo caminho do 300");
  });
});
