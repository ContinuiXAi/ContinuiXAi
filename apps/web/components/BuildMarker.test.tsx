import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BuildMarker } from "./BuildMarker";

describe("BuildMarker", () => {
  const originalPublicSha = process.env.NEXT_PUBLIC_BUILD_SHA;
  const originalRailwaySha = process.env.RAILWAY_GIT_COMMIT_SHA;

  afterEach(() => {
    if (originalPublicSha === undefined) delete process.env.NEXT_PUBLIC_BUILD_SHA;
    else process.env.NEXT_PUBLIC_BUILD_SHA = originalPublicSha;
    if (originalRailwaySha === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = originalRailwaySha;
  });

  it("shows Railway's exact deployed commit when no public build argument was supplied", () => {
    process.env.NEXT_PUBLIC_BUILD_SHA = "unknown";
    process.env.RAILWAY_GIT_COMMIT_SHA = "8674e7010f9c4f93458d76eb41b0649efa45083c";

    expect(renderToStaticMarkup(<BuildMarker />)).toContain("Build 8674e7010f9c");
  });

  it("declares Railway's commit as a Docker build argument before Next.js builds", () => {
    const dockerfile = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8");
    const declaration = dockerfile.indexOf("ARG RAILWAY_GIT_COMMIT_SHA");
    const build = dockerfile.indexOf("RUN npm run build -w apps/web");
    expect(declaration).toBeGreaterThan(-1);
    expect(declaration).toBeLessThan(build);
  });
});
