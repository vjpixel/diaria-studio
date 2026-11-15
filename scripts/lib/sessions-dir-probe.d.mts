import type { DataDirProbeFs, DataPathProbe } from "./data-dir-probe.mjs";

export type SessionsDirProbeFs = DataDirProbeFs;

export type SessionsDirProbe = DataPathProbe;

export function brokenSessionsLinkMessage(linkPath: string, code: string, target?: string): string;
export function probeSessionsDir(repoRoot: string, fs?: SessionsDirProbeFs): SessionsDirProbe;
