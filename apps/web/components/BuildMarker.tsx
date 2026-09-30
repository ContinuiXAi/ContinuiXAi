export function BuildMarker() {
  const publicSha = process.env.NEXT_PUBLIC_BUILD_SHA?.trim();
  const sha = publicSha && publicSha.toLowerCase() !== "unknown"
    ? publicSha
    : process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || "unknown";
  return <small aria-label="application build" style={{ display: "block", textAlign: "center", opacity: 0.55, padding: "8px" }}>Build {sha.slice(0, 12)}</small>;
}
