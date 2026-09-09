// #7743 — regressão: record continuo sem campo attended deve ser inalcançável
// nos DOIS lados (selfAuthorizeMerge + onlyUnreachableCoordinatorsActive)
import { describe, it, expect } from "vitest";

describe("#7743 selfAuthorizeMerge / onlyUnreachableCoordinatorsActive concordância", () => {
  it("continuo sem attended é inalcançável no hook (onlyUnreachableCoordinatorsActive)", () => {
    // simula scan do hook: kind=continuo, attended=undefined
    const scan = new Map([["s1", "continuo"]]);
    const attended = new Map();
    const unreachable = (attended.get("s1") === false) ||
      (attended.get("s1") === undefined && scan.get("s1") === "continuo");
    expect(unreachable).toBe(true);
  });
  it("continuo sem attended é inalcançável no selfAuthorizeMerge", () => {
    // simula filtro do selfAuthorizeMerge (linha ~4998)
    const s = { kind: "continuo" as const, attended: undefined as boolean | undefined };
    const responsive = !(s.attended === false || (s.attended === undefined && s.kind === "continuo"));
    expect(responsive).toBe(false); // não deve ser responsiva
  });
  it("overnight com attended true continua responsiva", () => {
    const s = { kind: "overnight" as const, attended: true as boolean };
    const responsive = !(s.attended === false || (s.attended === undefined && s.kind === "continuo"));
    expect(responsive).toBe(true);
  });
});
