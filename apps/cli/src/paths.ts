import {
  ensureInstallIdentity,
  ensureWorkspaceManifest,
  getAppDir,
  getInstallIdentityPath,
  getStaticAssetsInfo,
  getWorkspaceManifestPath,
  getWorkspaceRoot,
  WorkspaceAdoptionError,
  type WorkspaceManifest,
} from "@worktable/server/runtime";

// Version and release-tree resolution are owned by the server package (the
// path authority the CLI depends on) so an install has a single source of
// truth. Re-exported here to keep every existing `./paths.ts` import working.
export {
  VERSION,
  getExecutablePath,
  getReleaseDir,
} from "@worktable/server/runtime";
import { VERSION, getExecutablePath, getReleaseDir } from "@worktable/server/runtime";

export function getRuntimePaths(): Record<string, unknown> {
  const staticInfo = getStaticAssetsInfo();
  return {
    version: VERSION,
    executable: getExecutablePath(),
    releaseDir: getReleaseDir(),
    staticDir: staticInfo.staticDir,
    workspaceDir: getWorkspaceRoot(),
    appDir: getAppDir(),
  };
}

export function getDoctorPaths(): Record<string, unknown> {
  const staticInfo = getStaticAssetsInfo();
  const installIdentity = ensureInstallIdentity();
  const releaseDir = getReleaseDir();

  // A rejected workspace folder must not crash `doctor`; surface the error
  // instead and leave the id/manifest null so readers can report degraded.
  let workspaceManifest: WorkspaceManifest | null = null;
  let workspaceError: string | null = null;
  try {
    workspaceManifest = ensureWorkspaceManifest();
  } catch (err) {
    if (err instanceof WorkspaceAdoptionError) {
      workspaceError = err.message;
    } else {
      throw err;
    }
  }

  return {
    version: VERSION,
    platform: `${process.platform}/${process.arch}`,
    executable: getExecutablePath(),
    releaseDir,
    releaseManifest: releaseDir ? `${releaseDir}/manifest.json` : null,
    staticDir: staticInfo.staticDir,
    staticSource: staticInfo.source,
    staticChecked: staticInfo.checked,
    workspace: getWorkspaceRoot(),
    workspaceManifest: getWorkspaceManifestPath(),
    workspaceId: workspaceManifest?.id ?? null,
    workspaceError,
    appDir: getAppDir(),
    installIdentity: getInstallIdentityPath(),
    installId: installIdentity.id,
  };
}
