export function findRealGh(
  pathEnv: string | undefined,
  selfRealPath: string,
  deps?: { exists?: (path: string) => boolean; realpath?: (path: string) => string },
): string | null;
