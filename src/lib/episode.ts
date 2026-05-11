export function extractEpisodeNumber(value: string): string | null {
  const match = value.match(/\b(?:episode|ep)\s*(\d+(?:\.\d+)?)\b/i);
  return match?.[1] ?? null;
}
