export interface DataDirProbeFs {
  lstatSync(path: string): { isSymbolicLink(): boolean };
  statSync(path: string): unknown;
  readlinkSync?(path: string): string | { toString(): string };
}

export type SyncProvider = "google-drive" | "onedrive" | "unknown";

export type DataPathProbe =
  | { state: "present"; degraded: false }
  | { state: "absent"; degraded: false }
  | {
      state: "broken-link";
      degraded: true;
      path: string;
      code: string;
      target?: string;
      provider: SyncProvider;
      message: string;
    }
  | { state: "unreadable"; degraded: true; path: string; code: string; message: string };

export interface ProbeDataPathOptions {
  linkMessage?: (linkPath: string, code: string, target: string | undefined) => string;
}

export function detectSyncProvider(target: string | undefined): SyncProvider;
export function brokenDataLinkMessage(linkPath: string, code: string, target?: string): string;
export function probeDataPath(
  repoRoot: string,
  segments?: string[],
  fs?: DataDirProbeFs,
  opts?: ProbeDataPathOptions,
): DataPathProbe;
export function explainDataPathUnavailable(repoRoot: string, absPath: string, fs?: DataDirProbeFs): string | null;
