#!/usr/bin/env bun

// inspired by https://github.com/sst/opencode/blob/dev/script/publish.ts

import { $ } from "bun"

type Bump = "major" | "minor" | "patch"

type PackageJson = {
  name?: string
  version?: string
  private?: boolean
  exports?: Record<string, unknown>
  files?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const repoRoot = new URL("..", import.meta.url).pathname
process.chdir(repoRoot)

// ----- Script helper (channel + version) -----

const envChannel = process.env["OCX_CHANNEL"] ?? process.env["OPENCODE_CHANNEL"] ?? ""

const CHANNEL = envChannel.trim().length
  ? envChannel.trim()
  : ((await $`git branch --show-current`.text()).trim() || "latest")

const IS_PREVIEW = CHANNEL !== "latest"

const bumpEnv = (process.env["OCX_BUMP"] ?? "patch").toLowerCase()
const BUMP: Bump =
  bumpEnv === "major" || bumpEnv === "minor" || bumpEnv === "patch" ? bumpEnv : "patch"

const explicitVersion = (process.env["OCX_VERSION"] ?? "").trim()

function makePreviewVersion(channel: string): string {
  const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")
  return `0.0.0-${channel}-${ts}`
}

function bumpSemver(previous: string, bump: Bump): string {
  const [majorRaw, minorRaw, patchRaw] = previous.split(".")
  const major = Number.parseInt(majorRaw ?? "0", 10) || 0
  const minor = Number.parseInt(minorRaw ?? "0", 10) || 0
  const patch = Number.parseInt(patchRaw ?? "0", 10) || 0

  if (bump === "major") return `${major + 1}.0.0`
  if (bump === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

async function resolveVersion(): Promise<string> {
  if (explicitVersion) return explicitVersion
  if (IS_PREVIEW) return makePreviewVersion(CHANNEL)

  // Stable release: bump from current @better-slop/core version on npm
  const pkgName = "@better-slop/core"
  let previous = "0.0.0"

  try {
    const encoded = encodeURIComponent(pkgName)
    const res = await fetch(`https://registry.npmjs.org/${encoded}/latest`)
    if (res.ok) {
      const data = (await res.json()) as { version?: string }
      if (typeof data?.version === "string") {
        previous = data.version
      }
    } else if (res.status === 404) {
      console.warn(`npm package ${pkgName} not found, treating as initial release (0.0.0).`)
    } else {
      console.warn(
        `Failed to fetch npm version for ${pkgName} (status ${res.status}), defaulting to 0.0.0.`
      )
    }
  } catch (err) {
    console.warn(`Error fetching npm version for ${pkgName}, defaulting to 0.0.0:`, err)
  }

  return bumpSemver(previous, BUMP)
}

const VERSION = await resolveVersion()

const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
}

console.log(`ocx script`, JSON.stringify(Script, null, 2))

// ----- Helpers -----

async function readJson(path: string): Promise<PackageJson> {
  const text = await Bun.file(path).text()
  return JSON.parse(text) as PackageJson
}

async function writeJson(path: string, data: PackageJson): Promise<void> {
  const json = JSON.stringify(data, null, 2) + "\n"
  await Bun.write(path, json)
}

type PackageInfo = {
  path: string
  relativePath: string
  json: PackageJson
}

async function collectPackages(): Promise<PackageInfo[]> {
  const glob = new Bun.Glob("**/package.json")
  const files: PackageInfo[] = []

  for await (const file of glob.scan({ absolute: true })) {
    if (file.includes("node_modules") || file.includes("/dist/") || file.includes("/.git/")) {
      continue
    }
    const relativePath = file.startsWith(repoRoot + "/") ? file.slice(repoRoot.length + 1) : file
    const json = await readJson(file)
    files.push({ path: file, relativePath, json })
  }

  return files
}

function determinePublishTargets(pkgs: PackageInfo[]): PackageInfo[] {
  return pkgs.filter((pkg) => {
    const name = pkg.json.name ?? ""
    const isWorkspacePackage = pkg.relativePath.startsWith("packages/")
    const isBetterSlopScope = name.startsWith("@better-slop/")
    const isPrivate = pkg.json.private === true
    return isWorkspacePackage && isBetterSlopScope && !isPrivate
  })
}

// ----- Main flow -----

async function main() {
  console.log(
    `Releasing channel="${Script.channel}" version="${Script.version}" preview=${Script.preview}`
  )

  const packages = await collectPackages()

  // 1) Update version in all package.json files
  for (const pkg of packages) {
    pkg.json.version = Script.version
  }

  for (const pkg of packages) {
    await writeJson(pkg.path, pkg.json)
  }

  // 2) Reinstall to update bun.lock
  console.log("Running bun install to refresh lockfile...")
  await $`bun install`

  // 3) Publish non-private @better-slop/* packages from packages/*
  const publishTargets = determinePublishTargets(packages)
  if (publishTargets.length === 0) {
    console.warn("No publishable packages found under packages/*.")
  }

  for (const pkg of publishTargets) {
    const dir = pkg.relativePath.replace(/\/package\.json$/, "")
    const name = pkg.json.name ?? dir
    console.log(`Publishing ${name} from ${dir} with tag "${Script.channel}"...`)
    await $`cd ${dir} && bun publish --tag ${Script.channel} --access public`
  }

  // 4) For stable releases, commit, tag, push, and create GitHub release
  if (!Script.preview) {
    console.log("Stable release detected, committing and tagging...")

    await $`git commit -am "release: v${Script.version}"`
    await $`git push`
    await $`git tag v${Script.version}`
    await $`git push --tags`

    try {
      console.log("Creating GitHub release...")
      await $`gh release create v${Script.version} --title "v${Script.version}" --notes ""`
    } catch (err) {
      console.warn("Failed to create GitHub release via gh; tags were still pushed.", err)
    }
  } else {
    console.log("Preview release: skipping git commit/tag/push and GitHub release.")
  }

  console.log("Publish script completed.")
}

main().catch((err) => {
  console.error("Publish script failed:", err)
  process.exit(1)
})
