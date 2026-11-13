export interface SessionsDirProbeFs {
  lstatSync(path: string): { isSymbolicLink(): boolean };
  statSync(path: string): unknown;
}

export type SessionsDirProbe =
  | { state: "present"; degraded: false }
  | { state: "absent"; degraded: false }
  | { state: "broken-link" | "unreadable"; degraded: true; path: string; code: string; message: string };

export function brokenSessionsLinkMessage(linkPath: string, code: string): string;
export function probeSessionsDir(repoRoot: string, fs?: SessionsDirProbeFs): SessionsDirProbe;
