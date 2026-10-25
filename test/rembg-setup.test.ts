import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

it("capa horizontal aborta antes de ler insumos quando rembg está ausente", {
  skip: existsSync(new URL("../.venv-rembg/Scripts/python.exe", import.meta.url)),
}, () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/gen-youtube-thumb.ts",
    "261025", "--hook", "IA ladra?", "--portrait", "inexistente.png"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /rembg ausente ou inválido/);
  assert.match(result.stderr, /py -3\.11 scripts\/setup-rembg\.py/);
  assert.doesNotMatch(result.stderr, /inexistente.png não existe/);
});

const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"]).status === 0;
it("setup recusa venv errado e versão divergente sem instalar pacotes", { skip: !available }, () => {
  const result = spawnSync(python, ["-c", String.raw`
import runpy, sys
from unittest.mock import patch
m = runpy.run_path('scripts/setup-rembg.py')
check = m['check']
with patch.object(sys, 'version_info', (3,11,9)), patch.object(sys, 'prefix', '/wrong-venv'):
    try:
        check()
        raise AssertionError('aceitou Python global')
    except RuntimeError as e:
        assert 'venv' in str(e) and 'py -3.11' in str(e)
with patch.object(sys, 'version_info', (3,11,9)), patch.object(sys, 'prefix', str(m['VENV'])), patch('importlib.metadata.version', return_value='0.0.0'):
    try:
        check()
        raise AssertionError('aceitou versão divergente')
    except RuntimeError as e:
        assert 'Versão incorreta' in str(e)
with patch.object(sys, 'argv', ['setup-rembg.py']), patch.object(sys, 'platform', 'linux'), patch('subprocess.run') as run:
    try:
        m['main']()
        raise AssertionError('instalou no Linux')
    except RuntimeError as e:
        assert 'Neo' in str(e)
    run.assert_not_called()
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
