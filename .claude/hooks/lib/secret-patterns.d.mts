export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }>;
export function findSecrets(text: unknown): string[];
export function redactSecrets(text: string): string;
