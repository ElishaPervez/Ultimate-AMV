import type { InterpolateOutputFormat } from "../../types/interpolate";

// Shared by every panel that writes a video file, so the format cards and the
// file extensions they produce stay the same wherever the user meets them.
// ProRes carries no quality dial: the profile alone fixes how much detail
// survives, so the rate-control row is hidden rather than shown doing nothing.
export const OUTPUT_FORMATS: {
  key: InterpolateOutputFormat;
  label: string;
  hint: string;
  extension: string;
  rateControl: boolean;
}[] = [
  { key: "h264-mp4", label: "H.264 · MP4", hint: "Plays on everything", extension: "mp4", rateControl: true },
  { key: "hevc-mp4", label: "HEVC · MP4", hint: "Same look, smaller file", extension: "mp4", rateControl: true },
  { key: "h264-mkv", label: "H.264 · MKV", hint: "Keeps any audio track", extension: "mkv", rateControl: true },
  { key: "prores-mov", label: "ProRes · MOV", hint: "Near-lossless, very large", extension: "mov", rateControl: false },
];

export function outputFormatExtension(format: InterpolateOutputFormat): string {
  return OUTPUT_FORMATS.find((entry) => entry.key === format)?.extension || "mp4";
}
