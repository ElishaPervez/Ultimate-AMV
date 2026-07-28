// The clip extensions every video queue accepts. Kept here so the panels that
// build a queue agree with each other and with the Rust folder listing, which
// carries the same list.
export const VIDEO_EXTENSIONS = ["mp4", "mkv", "mov", "webm", "avi", "m4v"];

export function isSupportedVideoPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  const separator = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (dot <= separator) return false;
  return VIDEO_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

// A dropped item with no file extension is almost certainly a folder, so it is
// accepted here and expanded into its clips once the drop lands. Anything else
// with a non-video extension is rejected before the panel ever sees it.
export function acceptsDroppedPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  const separator = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return dot <= separator || isSupportedVideoPath(path);
}
