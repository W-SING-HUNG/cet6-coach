export * from "./types";
export { validatePaperManifest, formatIssuePath, mimeForPath } from "./validator";
export {
  NormalizedPackageImporter,
  ManifestReadError,
  validatePaperPackage,
  PAPER_MANIFEST_FILENAME,
} from "./importer";
export {
  getContentRoot,
  getPapersDir,
  normalizeRelativePath,
  resolveWithinRoot,
  isWithin,
  isRegularFile,
  UnsafePathError,
  // 展示用投影（见 paths.ts 的"展示用路径投影"一节）
  CONTENT_ROOT_DISPLAY_NAME,
  contentRootDisplayLabel,
  papersDirDisplayLabel,
  coursesDirDisplayLabel,
  courseSourcesDirDisplayLabel,
  toDisplayPath,
} from "./paths";
export { createPaperCatalog, PACKAGE_STATUS_LABELS } from "./catalog";
export type { PaperSummary, PaperDetail, PaperRepositoryBoundary, PackageStatus } from "./catalog";
