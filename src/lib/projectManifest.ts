import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { ClipPreviewItem } from "../types/clip";
import type {
  ProjectExportConfig,
  ProjectLoadResult,
  ProjectSourceItem,
  ResolvedSourceMedia,
  UAMVProjectManifest,
} from "../types/project";

export const MANIFEST_CURRENT_SCHEMA = "1.0.0";

export function extractFilenameFromPath(filePath: string): string {
  if (!filePath) return "";
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || filePath;
}

export function extractDirectoryFromPath(filePath: string): string {
  if (!filePath) return "";
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return filePath.slice(0, lastSlash);
}

export function createProjectManifest(params: {
  name: string;
  sources: ProjectSourceItem[];
  clips: ClipPreviewItem[];
  mergeGroupMap?: Record<string, string[]>;
  selectedClipIds?: string[];
  exportConfig?: ProjectExportConfig;
  notes?: string;
  appVersion?: string;
}): UAMVProjectManifest {
  const now = new Date().toISOString();

  // Sanitize clips: strip machine-local proxy runtime objects, keeping pure segment timing metadata
  const sanitizedClips: ClipPreviewItem[] = params.clips.map((clip) => {
    const cleanClip: ClipPreviewItem = {
      id: clip.id,
      index: clip.index,
      label: clip.label,
      range: clip.range,
      sourceName: clip.sourceName,
      sourceSrc: clip.sourceSrc,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
      previewStart: clip.previewStart,
      previewEnd: clip.previewEnd,
      fps: clip.fps,
      path: clip.path,
      isUnified: clip.isUnified,
      isContiguous: clip.isContiguous,
      segmentCount: clip.segmentCount,
    };

    if (clip.segments && Array.isArray(clip.segments)) {
      cleanClip.segments = clip.segments.map((seg) => ({
        source: seg.source,
        start: seg.start,
        end: seg.end,
        index: seg.index,
        fps: seg.fps,
        previewStart: seg.previewStart,
        previewEnd: seg.previewEnd,
      }));
    }

    return cleanClip;
  });

  return {
    schemaVersion: MANIFEST_CURRENT_SCHEMA,
    appVersion: params.appVersion,
    createdAt: now,
    modifiedAt: now,
    name: params.name,
    sources: params.sources,
    clips: sanitizedClips,
    mergeGroupMap: params.mergeGroupMap,
    selectedClipIds: params.selectedClipIds,
    exportConfig: params.exportConfig,
    notes: params.notes,
  };
}

export function serializeProjectManifest(manifest: UAMVProjectManifest): string {
  return JSON.stringify(manifest, null, 2);
}

export function parseProjectManifest(rawJson: string): UAMVProjectManifest {
  if (!rawJson || typeof rawJson !== "string") {
    throw new Error("Invalid project file: Empty or non-string content.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`Failed to parse project JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid project file structure.");
  }

  const manifest = parsed as Partial<UAMVProjectManifest>;

  if (manifest.schemaVersion !== MANIFEST_CURRENT_SCHEMA) {
    throw new Error(
      `Unsupported project schema version "${manifest.schemaVersion}". Expected version "${MANIFEST_CURRENT_SCHEMA}".`
    );
  }

  if (!Array.isArray(manifest.sources) || !Array.isArray(manifest.clips)) {
    throw new Error("Invalid project file: Missing sources or clips array.");
  }

  return parsed as UAMVProjectManifest;
}

export async function checkFileExists(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    return await invoke<boolean>("check_file_exists", { path });
  } catch {
    return false;
  }
}

export async function scanFolderForFiles(
  dir: string,
  targetNames: string[]
): Promise<Record<string, string>> {
  if (!dir || !targetNames || targetNames.length === 0) return {};
  try {
    return await invoke<Record<string, string>>("scan_folder_for_files", {
      dir,
      targetNames,
    });
  } catch {
    return {};
  }
}

export function normalizePath(filePath: string): string {
  if (!filePath) return "";
  return filePath.replace(/\\/g, "/").toLowerCase();
}

// Lists each episode once for a project file. Scene paths come first because
// the scanner rewrites what it opens (a mapped drive such as Z:\ comes back as
// \\server\share\), so they are what the project actually references. A picked
// path is only added when no scene references that episode, first translated
// through scannedPathByPick (what the scanner reported for that pick) so a
// picked path and its rewritten twin are never both listed.
export function collectProjectSourcePaths(
  scenePaths: string[],
  pickedPaths: string[],
  scannedPathByPick: Record<string, string> = {},
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (path: string) => {
    const key = normalizePath(path);
    if (!key || seen.has(key)) return;
    seen.add(key);
    paths.push(path);
  };
  scenePaths.forEach(add);
  pickedPaths.forEach((path) => add(scannedPathByPick[path] || path));
  return paths;
}

export async function resolveProjectSources(
  sources: ProjectSourceItem[],
  projectFilePath?: string
): Promise<ResolvedSourceMedia[]> {
  const projectDir = projectFilePath ? extractDirectoryFromPath(projectFilePath) : "";
  const missingNames: string[] = [];

  const checks = await Promise.all(
    sources.map(async (source) => {
      try {
        const exists = await checkFileExists(source.path);
        return { source, exists };
      } catch {
        return { source, exists: false };
      }
    })
  );

  const intermediateList: ResolvedSourceMedia[] = [];

  for (const { source, exists } of checks) {
    if (exists) {
      intermediateList.push({
        source,
        currentPath: source.path,
        status: "resolved",
      });
    } else {
      const name = source.filename || extractFilenameFromPath(source.path);
      missingNames.push(name);
      intermediateList.push({
        source,
        currentPath: source.path,
        status: "missing",
      });
    }
  }

  // If there are missing files and a project directory is available, check for same-named files there
  if (missingNames.length > 0 && projectDir) {
    try {
      const matchedFiles = await scanFolderForFiles(projectDir, missingNames);
      for (const item of intermediateList) {
        if (item.status === "missing") {
          const filename = item.source.filename || extractFilenameFromPath(item.source.path);
          const autoFound =
            matchedFiles[filename] ||
            matchedFiles[filename.toLowerCase()] ||
            matchedFiles[normalizePath(filename)];
          if (autoFound) {
            item.currentPath = autoFound;
            item.status = "resolved";
          }
        }
      }
    } catch {
      // Ignore scan failures; manual relink remains available
    }
  }

  return intermediateList;
}

export function remapClipsWithResolvedSources(
  clips: ClipPreviewItem[],
  pathMap: Record<string, string>
): ClipPreviewItem[] {
  if (!pathMap || Object.keys(pathMap).length === 0) return clips;

  const exactMap: Record<string, string> = {};
  const normalizedMap: Record<string, string> = {};
  const filenameMap: Record<string, string> = {};

  for (const [orig, resolved] of Object.entries(pathMap)) {
    if (!orig || !resolved) continue;
    exactMap[orig] = resolved;
    normalizedMap[normalizePath(orig)] = resolved;
    const fname = extractFilenameFromPath(orig).toLowerCase();
    if (fname) {
      filenameMap[fname] = resolved;
    }
  }

  function resolvePath(orig: string | undefined): string | undefined {
    if (!orig) return undefined;
    if (exactMap[orig]) return exactMap[orig];
    const norm = normalizePath(orig);
    if (normalizedMap[norm]) return normalizedMap[norm];
    const fname = extractFilenameFromPath(orig).toLowerCase();
    if (filenameMap[fname]) return filenameMap[fname];
    return orig;
  }

  return clips.map((clip) => {
    const newSource = resolvePath(clip.sourceSrc) || clip.sourceSrc;
    const newPath = resolvePath(clip.path) || newSource;
    const newSourceName = extractFilenameFromPath(newSource);

    const remapped: ClipPreviewItem = {
      ...clip,
      sourceSrc: newSource,
      sourceName: newSourceName || clip.sourceName,
      path: newPath,
      // Clear machine-specific proxy/transcode playback pointers so client resolves fresh
      playbackSrc: undefined,
      playbackMode: undefined,
      previewState: undefined,
    };

    if (clip.segments && Array.isArray(clip.segments)) {
      remapped.segments = clip.segments.map((seg) => ({
        ...seg,
        source: resolvePath(seg.source) || seg.source,
        playbackSrc: undefined,
        playbackMode: undefined,
      }));
    }

    return remapped;
  });
}

export async function exportProjectFile(
  manifest: UAMVProjectManifest,
  defaultName?: string
): Promise<string | null> {
  const content = serializeProjectManifest(manifest);
  const baseName = defaultName || manifest.name || "project";
  const defaultFileName = baseName.endsWith(".umv") ? baseName : `${baseName}.umv`;

  const selectedPath = await saveDialog({
    defaultPath: defaultFileName,
    filters: [
      { name: "UMV Project", extensions: ["umv"] },
      { name: "JSON File", extensions: ["json"] },
      { name: "All Files", extensions: ["*"] },
    ],
    title: "Export Project",
  });

  if (!selectedPath) {
    return null;
  }

  await invoke("write_file", { path: selectedPath, content });
  return selectedPath;
}

export async function importProjectFile(
  specifiedPath?: string
): Promise<ProjectLoadResult | null> {
  let targetPath = specifiedPath;

  if (!targetPath) {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [
        { name: "UMV Project", extensions: ["umv", "json"] },
        { name: "All Files", extensions: ["*"] },
      ],
      title: "Import Project",
    });

    if (!selected || typeof selected !== "string") {
      return null;
    }
    targetPath = selected;
  }

  const rawContent = await invoke<string>("read_file", { path: targetPath });
  const manifest = parseProjectManifest(rawContent);
  const resolvedSources = await resolveProjectSources(manifest.sources, targetPath);
  const hasMissingMedia = resolvedSources.some((s) => s.status === "missing");

  return {
    manifest,
    projectFilePath: targetPath,
    resolvedSources,
    hasMissingMedia,
  };
}
