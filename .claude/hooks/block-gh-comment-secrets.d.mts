export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }>;
export function findSecrets(text: unknown): string[];
export function redactSecrets(text: string): string;
export function isGhPublishCommand(command: unknown): boolean;
export function bodyFileArgs(command: string): string[];
export function evaluate(
  command: unknown,
  cwd?: string,
  readFile?: (path: string) => string,
): string | null;
