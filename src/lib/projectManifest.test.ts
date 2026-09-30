import { describe, expect, it } from "vitest";
import type { ClipPreviewItem } from "../types/clip";
import type { ProjectSourceItem } from "../types/project";
import {
  collectProjectSourcePaths,
  createProjectManifest,
  extractDirectoryFromPath,
  extractFilenameFromPath,
  parseProjectManifest,
  remapClipsWithResolvedSources,
  serializeProjectManifest,
} from "./projectManifest";

// What the app stores in sourceSrc: the in-app preview address for the file
// (the Windows form of convertFileSrc), not the file path itself. The real
// path lives in `path` and in each merged segment's `source`.
function assetUrl(filePath: string): string {
  return `http://asset.localhost/${encodeURIComponent(filePath)}`;
}

describe("projectManifest helpers", () => {
  it("extracts filenames and directories correctly across path styles", () => {
    expect(extractFilenameFromPath("C:\\Videos\\Anime\\ep1.mp4")).toBe("ep1.mp4");
    expect(extractFilenameFromPath("/home/user/videos/ep1.mp4")).toBe("ep1.mp4");
    expect(extractFilenameFromPath("ep1.mp4")).toBe("ep1.mp4");

    expect(extractDirectoryFromPath("C:\\Videos\\Anime\\ep1.mp4")).toBe("C:\\Videos\\Anime");
    expect(extractDirectoryFromPath("/home/user/videos/ep1.mp4")).toBe("/home/user/videos");
    expect(extractDirectoryFromPath("ep1.mp4")).toBe("");
  });

  it("creates, serializes, and parses a valid project manifest", () => {
    const sources: ProjectSourceItem[] = [
      {
        id: "src-1",
        path: "D:\\Footage\\Frieren_01.mp4",
        filename: "Frieren_01.mp4",
        duration: 1420.5,
        fps: 23.976,
      },
    ];

    const singleClip: ClipPreviewItem = {
      id: "clip-1",
      index: 1,
      label: "Scene 1",
      range: "00:01:00 - 00:01:05",
      sourceName: "Frieren_01.mp4",
      sourceSrc: assetUrl("D:\\Footage\\Frieren_01.mp4"),
      path: "D:\\Footage\\Frieren_01.mp4",
      sourceStart: 60,
      sourceEnd: 65,
      previewStart: 60.1,
      previewEnd: 64.9,
      fps: 23.976,
    };

    const unifiedClip: ClipPreviewItem = {
      id: "clip-unified",
      index: 2,
      label: "Merged Clip (2, 3)",
      range: "2 clips merged · 10.0s",
      sourceName: "Frieren_01.mp4",
      sourceSrc: assetUrl("D:\\Footage\\Frieren_01.mp4"),
      path: "D:\\Footage\\Frieren_01.mp4",
      sourceStart: 120,
      sourceEnd: 130,
      previewStart: 120,
      previewEnd: 130,
      fps: 23.976,
      isUnified: true,
      isContiguous: true,
      segmentCount: 2,
      segments: [
        {
          source: "D:\\Footage\\Frieren_01.mp4",
          start: 120,
          end: 125,
          index: 2,
          fps: 23.976,
          previewStart: 120.1,
          previewEnd: 124.9,
        },
        {
          source: "D:\\Footage\\Frieren_01.mp4",
          start: 125,
          end: 130,
          index: 3,
          fps: 23.976,
          previewStart: 125.1,
          previewEnd: 129.9,
        },
      ],
    };

    const manifest = createProjectManifest({
      name: "Frieren Edit",
      sources,
      clips: [singleClip, unifiedClip],
      mergeGroupMap: { "clip-unified": ["scene-2", "scene-3"] },
      selectedClipIds: ["clip-unified"],
      exportConfig: {
        format: "h264-nvenc",
        rateMode: "quality",
        audioSettings: { muted: false, volume: 1 },
      },
    });

    expect(manifest.schemaVersion).toBe("1.0.0");
    expect(manifest.clips.length).toBe(2);
    expect(manifest.clips[1].isUnified).toBe(true);
    expect(manifest.clips[1].segments?.length).toBe(2);

    const json = serializeProjectManifest(manifest);
    const parsed = parseProjectManifest(json);

    expect(parsed.name).toBe("Frieren Edit");
    expect(parsed.sources[0].filename).toBe("Frieren_01.mp4");
    expect(parsed.clips[1].segments?.[0].start).toBe(120);
    expect(parsed.exportConfig?.format).toBe("h264-nvenc");
  });

  it("throws on invalid or incompatible schema", () => {
    expect(() => parseProjectManifest("")).toThrow();
    expect(() => parseProjectManifest("{ not json }")).toThrow();
    expect(() =>
      parseProjectManifest(JSON.stringify({ schemaVersion: "2.0.0", sources: [], clips: [] }))
    ).toThrow(/Unsupported project schema version/);
  });

  it("remaps clips and unified segments to newly resolved media paths", () => {
    const oldPath = "C:\\Laptop\\ep1.mp4";
    const newPath = "E:\\Desktop\\Anime\\ep1.mp4";

    const clips: ClipPreviewItem[] = [
      {
        id: "clip-1",
        index: 1,
        label: "Scene 1",
        range: "00:00:10 - 00:00:15",
        sourceName: "ep1.mp4",
        sourceSrc: assetUrl(oldPath),
        path: oldPath,
        sourceStart: 10,
        sourceEnd: 15,
        previewStart: 10,
        previewEnd: 15,
        fps: 24,
        playbackSrc: "http://asset.localhost/proxy1.mp4",
        playbackMode: "proxy",
      },
      {
        id: "clip-merged",
        index: 2,
        label: "Merged Clip (2, 3)",
        range: "2 clips merged",
        sourceName: "ep1.mp4",
        sourceSrc: assetUrl(oldPath),
        path: oldPath,
        sourceStart: 20,
        sourceEnd: 30,
        previewStart: 20,
        previewEnd: 30,
        fps: 24,
        isUnified: true,
        segments: [
          {
            source: oldPath,
            start: 20,
            end: 25,
            index: 2,
            fps: 24,
          },
          {
            source: oldPath,
            start: 25,
            end: 30,
            index: 3,
            fps: 24,
          },
        ],
      },
    ];

    const remapped = remapClipsWithResolvedSources(clips, { [oldPath]: newPath });

    expect(remapped[0].path).toBe(newPath);
    expect(remapped[0].playbackSrc).toBeUndefined(); // Cleared machine-specific proxy
    expect(remapped[1].path).toBe(newPath);
    expect(remapped[1].segments?.[0].source).toBe(newPath);
    expect(remapped[1].segments?.[1].source).toBe(newPath);
  });

  it("remaps clips across mapped drive letters and UNC network paths", () => {
    const uncPath = "\\\\NAS\\Anime\\ep01.mp4";
    const localPath = "C:\\LocalAnime\\ep01.mp4";

    // The user picked Z:\Anime\ep01.mp4 on a mapped drive; the scanner rewrote it
    // to the UNC form, so the scene and the manifest both carry uncPath. Another
    // PC then relinks that episode to a local copy.
    const clips: ClipPreviewItem[] = [
      {
        id: "clip-1",
        index: 1,
        label: "Scene 1",
        range: "00:00:10 - 00:00:15",
        sourceName: "ep01.mp4",
        sourceSrc: assetUrl(uncPath),
        path: uncPath,
        sourceStart: 10,
        sourceEnd: 15,
        previewStart: 10,
        previewEnd: 15,
        fps: 24,
      },
    ];

    const remapped = remapClipsWithResolvedSources(clips, { [uncPath]: localPath });
    expect(remapped[0].path).toBe(localPath);
  });

  it("lists an episode once when the picked path differs from the scene's path", () => {
    const pickedPath = "Z:\\Anime\\ep01.mp4";
    const scannedPath = "\\\\NAS\\Anime\\ep01.mp4";

    const paths = collectProjectSourcePaths(
      [scannedPath, scannedPath],
      [pickedPath],
      { [pickedPath]: scannedPath },
    );

    expect(paths).toEqual([scannedPath]);
  });

  it("keeps picked episodes that no scene references, each only once", () => {
    const scannedEp1 = "\\\\NAS\\Anime\\ep01.mp4";
    const scannedEp2 = "\\\\NAS\\Anime\\ep02.mp4";

    const paths = collectProjectSourcePaths(
      [scannedEp1],
      ["Z:\\Anime\\ep01.mp4", "Z:\\Anime\\ep02.mp4", "Z:\\Anime\\ep03.mp4"],
      {
        "Z:\\Anime\\ep01.mp4": scannedEp1,
        // Scanned but produced no scenes: listed by the scanner's path.
        "Z:\\Anime\\ep02.mp4": scannedEp2,
        // ep03 was never scanned (batch cancelled): listed as picked.
      },
    );

    expect(paths).toEqual([scannedEp1, scannedEp2, "Z:\\Anime\\ep03.mp4"]);
  });

  it("treats paths that differ only by case or slash direction as one episode", () => {
    const paths = collectProjectSourcePaths(
      ["D:\\Footage\\Frieren_01.mp4", ""],
      ["d:/footage/FRIEREN_01.mp4"],
    );

    expect(paths).toEqual(["D:\\Footage\\Frieren_01.mp4"]);
  });
});
