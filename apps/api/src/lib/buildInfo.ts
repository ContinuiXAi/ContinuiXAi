export function resolveBuildSha(env: NodeJS.ProcessEnv = process.env): string {
  return env.BUILD_SHA?.trim() || env.RAILWAY_GIT_COMMIT_SHA?.trim() || "unknown";
}
