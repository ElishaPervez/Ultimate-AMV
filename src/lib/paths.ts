export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function fileStem(path: string): string {
  return fileName(path).replace(/\.[^.]+$/, "");
}

export function normalizeSelectedPaths(selected: string | string[] | null): string[] {
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}
