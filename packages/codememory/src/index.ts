export {
  captureSnapshot,
  detectChanges,
  compareSnapshots,
} from './fingerprints';
export {
  createPathFilter,
  resolveRepositoryRoot,
  scanWorktree,
  type WorktreeScan,
} from './fingerprints';
export { createDriftWatcher } from './drift';
export { computeSymbolsHash, extractSymbolTable } from './symbols';
export { languageForPath, SOURCE_EXTENSIONS } from './grammar';
export {
  FileFingerprintSchema,
  FingerprintOptionsSchema,
  RepositorySnapshotSchema,
  RepositoryPathSchema,
  DetectDriftInputSchema,
  SymbolFileSchema,
  SymbolKindSchema,
  SymbolLanguageSchema,
  SymbolOptionsSchema,
  SymbolRecordSchema,
  SymbolTableSchema,
  SkippedSymbolFileSchema,
  FingerprintError,
  type FileFingerprint,
  type RepositorySnapshot,
  type FingerprintOptions,
  type FileChange,
  type FingerprintChangeReport,
  type SkippedPath,
  type DetectDriftInput,
  type SymbolFile,
  type SymbolKind,
  type SymbolLanguage,
  type SymbolOptions,
  type SymbolRecord,
  type SymbolTable,
  type SkippedSymbolFile,
} from './schema';
