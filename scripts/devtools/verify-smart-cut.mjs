/**
 * DEV TOOL — smart-cut verification. Nothing in the app imports this file, so
 * it ships nowhere; run it by hand against real media.
 *
 *   node scripts/devtools/verify-smart-cut.mjs <source> <start> <end> [options]
 *
 *   --keep                keep the working directory and print its path
 *   --expect-refusal      the source SHOULD be refused (AV1 / VFR samples);
 *                         a refusal passes, a successful cut fails
 *   --ffmpeg <path>       override the ffmpeg binary
 *   --ffprobe <path>      override the ffprobe binary
 *   --out <path>          where to write the cut (default: inside the work dir)
 *
 * It repeats the backend's procedure (probe -> head re-encode -> body copy ->
 * concat -> audio mux, see run_smart_cut_clip in src-tauri/src/clips.rs) and
 * then checks the result:
 *
 *   1. Frame accuracy   output frame 0 vs the source frame at <start>, SSIM >= 0.98
 *                       (or a clear win over both neighbouring frames)
 *   2. Joint integrity  ~10 frames across the head/body seam decode, and no
 *                       single frame pair collapses (no gray/glitch frame)
 *   3. Duration         output length within two frames of <end> - <start>
 *   4. Stream copy      the output's body packets are the source's packets,
 *                       size for size
 *   5. Audio alignment  the copied audio starts at the cut, not at the keyframe
 *                       an input seek would have snapped back to
 *
 * Exit code 0 only when every check passes.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ─── tool resolution ─────────────────────────────────────────────────────────

// Mirrors find_tool()/tools_dir_path() in src-tauri/src/python_env.rs: the
// env override wins, then a repo-local tools/, then the installed app's tools
// dir, then whatever is on PATH.
function resolveTool(name, override) {
  if (override) return override;
  const candidates = [];
  if (process.env.ULTIMATE_AMV_TOOLS_DIR) {
    candidates.push(path.join(process.env.ULTIMATE_AMV_TOOLS_DIR, `${name}.exe`));
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  candidates.push(path.join(repoRoot, "tools", `${name}.exe`));
  if (process.env.LOCALAPPDATA) {
    candidates.push(
      path.join(process.env.LOCALAPPDATA, "com.elishapervez.ultimateamv", "tools", `${name}.exe`),
    );
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
}

// ─── process helpers ─────────────────────────────────────────────────────────

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    return { ok: false, stdout: "", stderr: String(result.error), code: -1 };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
}

function runOrDie(bin, args, what) {
  const result = run(bin, args);
  if (!result.ok) {
    console.error(`\n${what} failed (exit ${result.code}):`);
    console.error(result.stderr.trim().split("\n").slice(-12).join("\n"));
    process.exit(1);
  }
  return result;
}

// ─── the backend's rules, repeated here ──────────────────────────────────────

function refusal(reason) {
  return `Smart cut can't splice this source's video format (${reason}). Use "Lossless cut" for a byte-exact export (cuts snap to keyframes) or any re-encode preset for frame-accurate output.`;
}

function parseFpsRational(value) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  let fps;
  if (trimmed.includes("/")) {
    const [num, den] = trimmed.split("/");
    const d = Number(den);
    if (!d) return null;
    fps = Number(num) / d;
  } else {
    fps = Number(trimmed);
  }
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

function pixFmtBitDepth(pixFmt) {
  const value = (pixFmt ?? "").trim();
  if (!value) return null;
  const trimmed = value.replace(/(le|be)$/, "");
  const tail = trimmed.split("p").pop() ?? "";
  if (tail === "") return 8;
  if (!/^\d+$/.test(tail)) return 8;
  const depth = Number(tail);
  return depth >= 8 && depth <= 16 ? depth : null;
}

function headEncoderArgs(codec, pixFmt) {
  const depth = pixFmtBitDepth(pixFmt);
  if (codec === "h264" && depth === 8) {
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", pixFmt];
  }
  if (codec === "h264" && depth === 10) {
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "12", "-profile:v", "high10", "-pix_fmt", "yuv420p10le"];
  }
  if (codec === "hevc" && depth === 8) {
    return ["-c:v", "libx265", "-preset", "medium", "-crf", "14", "-pix_fmt", pixFmt];
  }
  if (codec === "hevc" && depth === 10) {
    return ["-c:v", "libx265", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p10le"];
  }
  if (codec === "h264" || codec === "hevc") {
    throw new Error(refusal(`${codec} ${pixFmt}`));
  }
  throw new Error(refusal(codec || "unknown"));
}

function firstKeyframeAtOrAfter(csv, start, tolerance) {
  let earliest = null;
  for (const line of csv.split("\n")) {
    const fields = line.split(",");
    const pts = Number(fields[0]);
    if (!Number.isFinite(pts) || fields.length < 2) continue;
    if (!fields[1].includes("K") || pts < start - tolerance) continue;
    if (earliest === null || pts < earliest) earliest = pts;
  }
  return earliest;
}

// ─── checks ──────────────────────────────────────────────────────────────────

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ffmpeg prints the SSIM summary on stderr as "... All:0.987654 (19.1)".
function ssim(ffmpeg, a, b) {
  const result = run(ffmpeg, ["-hide_banner", "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"]);
  const match = /All:([0-9.]+)/.exec(result.stderr);
  if (!result.ok || !match) return null;
  return Number(match[1]);
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function packets(ffprobe, file, stream, from, seconds) {
  const result = run(ffprobe, [
    "-v", "error",
    "-select_streams", stream,
    "-show_entries", "packet=pts_time,size",
    "-read_intervals", `${Math.max(0, from).toFixed(3)}%+${seconds}`,
    "-of", "csv=p=0",
    file,
  ]);
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.split(","))
    .filter((fields) => fields.length >= 2 && Number.isFinite(Number(fields[0])))
    .map((fields) => ({ pts: Number(fields[0]), size: Number(fields[1]) }))
    .sort((x, y) => x.pts - y.pts);
}

// The copied packets must be the source's packets. Sizes are compared rather
// than bytes: two encodes never coincide on a packet-size sequence, so an
// aligned run of matching sizes means the bitstream came across untouched.
// The alignment is retried from the first few output packets because the very
// first one legitimately differs: a keyframe re-muxed into MKV carries its
// parameter sets in-band, so it comes out a few dozen bytes bigger than the
// source's.
function matchingRun(sourceSizes, outputSizes) {
  let best = { offset: -1, matched: 0 };
  for (let skip = 0; skip < Math.min(3, outputSizes.length); skip += 1) {
    const offset = sourceSizes.indexOf(outputSizes[skip]);
    if (offset < 0) continue;
    let matched = 0;
    while (
      skip + matched < outputSizes.length &&
      offset + matched < sourceSizes.length &&
      outputSizes[skip + matched] === sourceSizes[offset + matched]
    ) {
      matched += 1;
    }
    if (matched > best.matched) best = { offset: offset - skip, matched };
  }
  return best;
}

// ─── main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--keep" || arg === "--expect-refusal") continue;
  if (arg.startsWith("--")) {
    i += 1;
    continue;
  }
  positional.push(arg);
}

if (positional.length < 3) {
  console.error("Usage: node scripts/devtools/verify-smart-cut.mjs <source> <start> <end> [--keep] [--expect-refusal] [--ffmpeg path] [--ffprobe path] [--out path]");
  process.exit(2);
}

const source = path.resolve(positional[0]);
const start = Number(positional[1]);
const end = Number(positional[2]);
const keep = argv.includes("--keep");
const expectRefusal = argv.includes("--expect-refusal");
const ffmpeg = resolveTool("ffmpeg", flag("--ffmpeg"));
const ffprobe = resolveTool("ffprobe", flag("--ffprobe"));

if (!fs.existsSync(source)) {
  console.error(`No such file: ${source}`);
  process.exit(2);
}
if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
  console.error("<start> and <end> must be seconds, with end greater than start.");
  process.exit(2);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-smart-cut-"));
const output = flag("--out") ? path.resolve(flag("--out")) : path.join(workDir, "smartcut.mkv");
const duration = end - start;

console.log(`source   ${source}`);
console.log(`range    ${start.toFixed(3)} -> ${end.toFixed(3)} (${duration.toFixed(3)}s)`);
console.log(`ffmpeg   ${ffmpeg}`);
console.log(`work dir ${workDir}\n`);

// 1. Probe the source the way the backend does.
const probe = runOrDie(ffprobe, [
  "-v", "error",
  "-select_streams", "v:0",
  "-show_entries", "stream=codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate",
  "-of", "json",
  source,
], "Probing the source");
const stream = JSON.parse(probe.stdout).streams?.[0];
if (!stream) {
  console.error("This file has no video stream to cut.");
  process.exit(1);
}

const avgFps = parseFpsRational(stream.avg_frame_rate);
const nominalFps = parseFpsRational(stream.r_frame_rate);
let headArgs = null;
let refusalMessage = null;
try {
  if (!avgFps || !nominalFps || Math.abs(avgFps - nominalFps) / Math.max(avgFps, nominalFps) > 0.01) {
    throw new Error(refusal("variable frame rate"));
  }
  headArgs = headEncoderArgs(stream.codec_name, stream.pix_fmt);
} catch (error) {
  refusalMessage = error.message;
}

console.log(`codec    ${stream.codec_name} ${stream.pix_fmt} @ ${stream.avg_frame_rate} (nominal ${stream.r_frame_rate})`);

if (refusalMessage) {
  console.log(`\nRefused: ${refusalMessage}`);
  if (!keep) fs.rmSync(workDir, { recursive: true, force: true });
  if (expectRefusal) {
    console.log("\nPASS  expected refusal");
    process.exit(0);
  }
  console.log("\nFAIL  the source was refused");
  process.exit(1);
}
if (expectRefusal) {
  console.log("\nFAIL  expected a refusal, but this source is spliceable");
  if (!keep) fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const fps = avgFps;
const tolerance = 0.5 / fps;

// 2. Find the keyframe the head has to reach.
const keyframeProbe = run(ffprobe, [
  "-v", "error",
  "-select_streams", "v:0",
  "-show_entries", "packet=pts_time,flags",
  "-read_intervals", `${start.toFixed(3)}%+40`,
  "-of", "csv=p=0",
  source,
]);
const keyframe = keyframeProbe.ok ? firstKeyframeAtOrAfter(keyframeProbe.stdout, start, tolerance) : null;
console.log(`keyframe ${keyframe === null ? "none in the 40s window" : keyframe.toFixed(3)}`);

const onKeyframe = keyframe !== null && Math.abs(keyframe - start) < tolerance;
const spliced = keyframe !== null && !onKeyframe && keyframe < end - tolerance;

// 3. Produce the cut, exactly as run_smart_cut_clip does.
//
// The head and body are VIDEO-ONLY and the audio is cut separately: ffmpeg
// leaves a re-encoded video stream on the source timeline whenever a copied
// audio stream shares the output, which makes the concat demuxer push the body
// out by the whole head offset.
const hasAudio = run(ffprobe, [
  "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type",
  "-of", "default=nokey=1:noprint_wrappers=1", source,
]).stdout.includes("audio");

const headVideoArgs = (length, target, asTs) => [
  "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
  "-ss", start.toFixed(3),
  "-i", source,
  "-t", length.toFixed(3),
  "-map", "0:v:0",
  ...headArgs,
  ...(asTs ? ["-f", "mpegts"] : []),
  target,
];

const video = path.join(workDir, "video.mkv");

if (onKeyframe) {
  console.log("path     pure copy (the cut already lands on a keyframe)\n");
  runOrDie(ffmpeg, [
    "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
    "-ss", keyframe.toFixed(6),
    "-i", source,
    "-t", (end - keyframe).toFixed(3),
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    output,
  ], "Copying the clip");
} else {
  if (spliced) {
    console.log("path     head re-encode + body copy + concat\n");
    // The pieces are joined as MPEG-TS: MKV stores codec parameter sets once in
    // the header, so a re-encoded head makes the muxer reject the untouched
    // body's packets. Transport streams carry them in-band per keyframe.
    //
    // Neither piece gets -avoid_negative_ts make_zero: on a stream copy it
    // shifts every packet forward by the first frame's DTS/PTS gap and drags
    // two frames from before the keyframe into the body.
    const head = path.join(workDir, "head.ts");
    const body = path.join(workDir, "body.ts");
    runOrDie(ffmpeg, headVideoArgs(keyframe - start, head, true), "Encoding the head");
    runOrDie(ffmpeg, [
      "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
      "-ss", keyframe.toFixed(6),
      "-i", source,
      "-t", (end - keyframe).toFixed(3),
      "-map", "0:v:0",
      "-c", "copy",
      "-f", "mpegts",
      body,
    ], "Copying the body");
    const listPath = path.join(workDir, "concat.txt");
    fs.writeFileSync(listPath, [head, body].map((file) => `file '${file.replace(/'/g, "'\\''")}'\n`).join(""));
    runOrDie(ffmpeg, [
      "-y", "-hide_banner", "-nostdin",
      "-f", "concat", "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      // Strips the access-unit delimiters the transport-stream intermediates
      // added, so the body's packets stay byte-identical to the source's.
      "-bsf:v", `${stream.codec_name}_metadata=aud=remove`,
      video,
    ], "Joining head and body");
  } else {
    console.log("path     full re-encode (no keyframe inside the clip)\n");
    runOrDie(ffmpeg, headVideoArgs(duration, video, false), "Re-encoding the clip");
  }

  if (!hasAudio) {
    fs.renameSync(video, output);
  } else {
    // Two-stage seek: the input -ss lands the demuxer on a keyframe at or
    // before the cut, then the output -ss — counted from the REQUESTED input
    // seek, not from where the demuxer landed — drops the overshoot. An input
    // seek alone would hand back everything from that keyframe on.
    const audio = path.join(workDir, "audio.mka");
    const seekFrom = Math.max(0, start - 15);
    runOrDie(ffmpeg, [
      "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
      "-ss", seekFrom.toFixed(3),
      "-i", source,
      "-ss", (start - seekFrom).toFixed(3),
      "-t", duration.toFixed(3),
      "-map", "0:a:0",
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      audio,
    ], "Copying the audio");
    runOrDie(ffmpeg, [
      "-y", "-hide_banner", "-nostdin",
      "-i", video,
      "-i", audio,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c", "copy",
      output,
    ], "Muxing video and audio");
  }
}

// ─── check 1: the first frame is the requested frame ─────────────────────────

const outFrame = path.join(workDir, "out_first.png");
const srcFrame = path.join(workDir, "src_at_start.png");
runOrDie(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", output, "-frames:v", "1", outFrame], "Extracting the output's first frame");
runOrDie(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", start.toFixed(3), "-i", source, "-frames:v", "1", srcFrame], "Extracting the source frame at the cut");
const firstFrameSsim = ssim(ffmpeg, outFrame, srcFrame);
// Neighbours as a control: on grainy or synthetic footage a correct frame can
// score below 0.98 purely from the head re-encode, so a frame that beats both
// of its neighbours by a wide margin also counts as landing on the mark.
const neighbourSsim = [-1, 1].map((step) => {
  const at = start + step / fps;
  if (at < 0) return null;
  const frame = path.join(workDir, `src_${step > 0 ? "next" : "prev"}.png`);
  const extract = run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", at.toFixed(3), "-i", source, "-frames:v", "1", frame]);
  return extract.ok ? ssim(ffmpeg, outFrame, frame) : null;
});
const bestNeighbour = Math.max(...neighbourSsim.map((value) => value ?? 0));
record(
  "frame accuracy: output frame 0 is the source frame at the cut",
  firstFrameSsim !== null && (firstFrameSsim >= 0.98 || (firstFrameSsim > bestNeighbour + 0.05 && firstFrameSsim >= 0.9)),
  firstFrameSsim === null
    ? "SSIM could not be measured"
    : `SSIM ${firstFrameSsim.toFixed(4)} at the cut vs ${bestNeighbour.toFixed(4)} for the nearest neighbouring frame`,
);

// ─── check 2: nothing breaks across the head/body seam ───────────────────────

if (spliced) {
  const seam = Math.max(0, keyframe - start - 5 / fps);
  const seamDir = path.join(workDir, "seam");
  fs.mkdirSync(seamDir, { recursive: true });
  const extract = run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", seam.toFixed(3),
    "-i", output,
    "-t", (10 / fps).toFixed(3),
    path.join(seamDir, "f_%03d.png"),
  ]);
  const frames = fs.existsSync(seamDir) ? fs.readdirSync(seamDir).sort() : [];
  if (!extract.ok || frames.length < 4) {
    record("joint integrity: frames across the seam decode", false, `decoded ${frames.length} frames${extract.ok ? "" : " (ffmpeg errored)"}`);
  } else {
    const pairs = [];
    for (let i = 1; i < frames.length; i += 1) {
      const value = ssim(ffmpeg, path.join(seamDir, frames[i - 1]), path.join(seamDir, frames[i]));
      if (value !== null) pairs.push(value);
    }
    const worst = Math.min(...pairs);
    const typical = median(pairs);
    const outlier = worst < typical - 0.35 || worst < 0.2;
    record(
      "joint integrity: no glitch frame at the head/body seam",
      !outlier,
      `${frames.length} frames, worst consecutive SSIM ${worst.toFixed(4)} vs median ${typical.toFixed(4)}`,
    );
  }
} else {
  record("joint integrity: no head/body seam to check", true, onKeyframe ? "pure copy" : "full re-encode");
}

// ─── check 3: the clip is as long as it was asked to be ──────────────────────

// Counted in video frames, not container seconds: a copied audio stream can
// overhang the last video frame by an audio-frame's worth, which would make a
// seconds comparison fail on a cut that is exactly right.
const frameProbe = run(ffprobe, [
  "-v", "error",
  "-select_streams", "v:0",
  "-show_entries", "packet=pts_time",
  "-of", "csv=p=0",
  output,
]);
const outFrames = frameProbe.stdout.split("\n").filter((line) => line.trim() !== "" && Number.isFinite(Number(line))).length;
const wantFrames = Math.round(duration * fps);
// A quarter-second of slack. The body is copied, so it can only end on a packet
// boundary, and an open-GOP source hands over a few leading pictures with the
// keyframe — both add frames at the ends that no stream copy can trim.
const frameSlack = Math.max(2, Math.round(fps / 4));
record(
  "duration: output length matches the requested range",
  frameProbe.ok && Math.abs(outFrames - wantFrames) <= frameSlack,
  `${outFrames} frames vs ${wantFrames} expected (${(outFrames / fps).toFixed(3)}s vs ${duration.toFixed(3)}s)`,
);

// ─── check 4: the body really is the original bitstream ──────────────────────

if (spliced || onKeyframe) {
  const bodyStartInOutput = onKeyframe ? 0 : keyframe - start;
  const seconds = Math.min(4, Math.max(1, Math.floor(end - keyframe)));
  // ffprobe's read interval starts at the keyframe at or before the requested
  // point, so the head's packets can lead the list — drop anything before the
  // body starts.
  const sourceSizes = packets(ffprobe, source, "v:0", keyframe, seconds)
    .filter((packet) => packet.pts >= keyframe - 0.001)
    .map((packet) => packet.size);
  const outputSizes = packets(ffprobe, output, "v:0", bodyStartInOutput, seconds)
    .filter((packet) => packet.pts >= bodyStartInOutput - 0.001)
    .map((packet) => packet.size);
  const { matched } = matchingRun(sourceSizes, outputSizes);
  record(
    "stream copy: the body's packets are the source's packets",
    matched >= 5 && matched >= Math.min(outputSizes.length, sourceSizes.length) - 1,
    `${matched} of ${outputSizes.length} output packets match the source packet for packet`,
  );
} else {
  record("stream copy: nothing was copied (full re-encode)", true, "no body segment");
}

// ─── check 5: the audio starts where the video does ──────────────────────────

// Catches the failure this tool was written for: an input seek alone snaps back
// to a keyframe, so the audio can silently come from seconds earlier than the
// requested cut while the video is perfect.
if (hasAudio) {
  // The pure-copy path has no separate audio cut: ffmpeg's own seek hands back
  // audio from shortly before the video keyframe, exactly as the shipped
  // Lossless cut preset does, so it is allowed a wider lead-in.
  const lead = onKeyframe ? 0.3 : 0.05;
  const sourceAudio = packets(ffprobe, source, "a:0", Math.max(0, start - 1), 6)
    .filter((packet) => packet.pts >= start - lead)
    .map((packet) => packet.size);
  const outputAudio = packets(ffprobe, output, "a:0", 0, 4).map((packet) => packet.size);
  const { offset, matched } = matchingRun(sourceAudio, outputAudio);
  // offset counts how many source packets sit between the cut and where the
  // output's audio begins. A packet or two is the audio frame grid; seconds'
  // worth means the cut snapped back to a keyframe and the audio is from the
  // wrong place entirely.
  const aligned = matched >= 10 && offset >= 0 && offset <= (onKeyframe ? 16 : 3);
  record(
    "audio: copied from the requested cut, not from an earlier keyframe",
    aligned,
    `${matched} packets match, starting ${offset < 0 ? "nowhere near" : `${offset} packet(s) past`} the requested cut`,
  );
} else {
  record("audio: source has no audio track", true, "nothing to align");
}

// ─── verdict ─────────────────────────────────────────────────────────────────

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (keep) {
  console.log(`kept ${workDir}`);
} else {
  fs.rmSync(workDir, { recursive: true, force: true });
}
process.exit(failed.length === 0 ? 0 : 1);
