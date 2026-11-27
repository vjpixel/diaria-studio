// Import e appliesTo isolados do event loop do despachante (#14302).
// IPC separado do stdout: imports não podem corromper o protocolo.
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", async () => {
  let result;
  try {
    const mod = await import(process.argv[2]);
    if (typeof mod.appliesTo !== "function") throw new Error("não exporta appliesTo (contrato #14045)");
    result = { applies: mod.appliesTo(JSON.parse(raw || "{}")) === true };
  } catch (err) {
    result = { error: err?.message ?? String(err) };
  }
  process.send(result, () => process.exit(0));
});
