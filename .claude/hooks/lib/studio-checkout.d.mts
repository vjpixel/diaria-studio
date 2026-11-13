export const STUDIO_SIGNATURE_FILE: string;
export function gitCommonDir(dir: string | null | undefined, execFn?: (...args: never[]) => unknown): string | null;
export function studioLogRoot(hookDir: string, execFn?: (...args: never[]) => unknown): string;
export function isStudioCheckout(
  cwd: string,
  hookDir: string,
  deps?: { execFn?: (...args: never[]) => unknown; exists?: (path: string) => boolean },
): boolean | null;
