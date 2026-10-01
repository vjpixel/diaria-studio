export function appendHookRunLog(
  repoRoot: string | null | undefined,
  agent: string,
  level: "info" | "warn" | "error",
  message: string,
  details?: Record<string, unknown>,
  deps?: {
    appendFn?: (path: string, data: string, enc: "utf8") => void;
    mkdirFn?: (path: string, opts: { recursive: true }) => unknown;
  },
): void;
