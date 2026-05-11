export function formatHms(seconds: number, withMillis: boolean): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  const pad = (value: number, width = 2) => value.toString().padStart(width, "0");
  const base = `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)}`;
  return withMillis ? `${base}.${pad(ms, 3)}` : base;
}

export function parseHms(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const [secondsPart, msPart] = trimmed.split(".");
  const ms = msPart ? Number(`0.${msPart.replace(/[^0-9]/g, "")}`) : 0;
  if (!Number.isFinite(ms)) return null;
  const segments = secondsPart.split(":").map((segment) => segment.trim());
  if (segments.some((segment) => segment === "" || !/^\d+$/.test(segment))) return null;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (segments.length === 1) {
    seconds = Number(segments[0]);
  } else if (segments.length === 2) {
    minutes = Number(segments[0]);
    seconds = Number(segments[1]);
  } else if (segments.length === 3) {
    hours = Number(segments[0]);
    minutes = Number(segments[1]);
    seconds = Number(segments[2]);
  } else {
    return null;
  }
  const total = hours * 3600 + minutes * 60 + seconds + ms;
  return Number.isFinite(total) ? total : null;
}
