import { it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeOpenCv } from "../scripts/check-video-env.ts";
import { assessMontageEnv, formatMontageEnvReport } from "../scripts/lib/diaria/video-montage-env.ts";

it("#12906 OpenCV ausente avisa com fallback manual; dependência obrigatória continua bloqueando", () => {
  const ok = { ok: true };
  const probes = { ffmpeg: ok, python: ok, model: ok, drive: ok, disk: ok, opencv: { ok: false, detail: "No module named 'cv2'" } };
  const r = assessMontageEnv(probes, "linux", { python: "/isolated/python", from: "flag" });
  assert.equal(r.ready, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.warnings, ["opencv"]);
  assert.match(formatMontageEnvReport(r), /\[aviso\] opencv.*cv2.*montagem-requirements.txt.*manual/);
  const failed = assessMontageEnv({ ...probes, python: { ok: false } }, "linux", r.python);
  assert.equal(failed.ready, false);
  assert.deepEqual(failed.missing, ["python"]);
  const ready = assessMontageEnv({ ...probes, opencv: ok }, "linux", r.python);
  assert.deepEqual(ready.warnings, []);
  assert.match(formatMontageEnvReport(ready), /\[ok\] opencv/);
});

it("#12906 a sonda executa import cv2 no Python selecionado e propaga falha de import/ABI", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "opencv-probe-"));
  try {
    const python = join(dir, "python");
    writeFileSync(python, `#!/bin/sh\n[ "$1" = '-P' ] && [ "$2" = '-c' ] && [ "$3" = "import cv2; print('OpenCV', cv2.__version__)" ] || exit 42\necho 'OpenCV 4.11.0'\n`);
    chmodSync(python, 0o755);
    assert.deepEqual(probeOpenCv(python), { ok: true, detail: "OpenCV 4.11.0" });
    for (const error of ["ModuleNotFoundError: cv2", "ImportError: numpy.core.multiarray failed to import"]) {
      writeFileSync(python, `#!/bin/sh\necho '${error}' >&2\nexit 1\n`);
      assert.deepEqual(probeOpenCv(python), { ok: false, detail: error });
    }
    assert.equal(probeOpenCv(join(dir, "missing-python")).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("#12906 requirements fixa OpenCV headless e o preflight usa o mesmo Python da montagem", () => {
  const lock = readFileSync(new URL("../scripts/video/montagem-requirements.txt", import.meta.url), "utf8");
  assert.match(lock, /^opencv-python-headless==4\.11\.0\.86$/m);
  const source = readFileSync(new URL("../scripts/check-video-env.ts", import.meta.url), "utf8");
  assert.match(source, /opencv: probeOpenCv\(py.python\)/);
});
