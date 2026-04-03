import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--output") {
      args.output = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed for ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function githubText(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream",
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`Asset download failed for ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function findAsset(assets, matcher, label) {
  const asset = assets.find((candidate) => matcher(candidate.name));
  if (!asset) {
    throw new Error(`Could not find release asset for ${label}`);
  }
  return asset;
}

async function buildFeed(release, token) {
  const assets = release.assets ?? [];
  const windows = findAsset(assets, (name) => /-setup\.exe$/i.test(name), "Windows setup executable");
  const windowsSig = findAsset(assets, (name) => /-setup\.exe\.sig$/i.test(name), "Windows signature");
  const linux = findAsset(assets, (name) => /\.AppImage$/i.test(name), "Linux AppImage");
  const linuxSig = findAsset(assets, (name) => /\.AppImage\.sig$/i.test(name), "Linux AppImage signature");
  const mac = findAsset(assets, (name) => /\.app\.tar\.gz$/i.test(name), "macOS updater archive");
  const macSig = findAsset(assets, (name) => /\.app\.tar\.gz\.sig$/i.test(name), "macOS updater signature");

  const [windowsSignature, linuxSignature, macSignature] = await Promise.all([
    githubText(windowsSig.browser_download_url, token),
    githubText(linuxSig.browser_download_url, token),
    githubText(macSig.browser_download_url, token)
  ]);

  return {
    version: release.tag_name.replace(/^plugin-manager-v/, ""),
    notes: release.body?.trim() || `Manager release ${release.tag_name}`,
    pub_date: release.published_at,
    platforms: {
      "windows-x86_64": {
        signature: windowsSignature.trim(),
        url: windows.browser_download_url
      },
      "linux-x86_64": {
        signature: linuxSignature.trim(),
        url: linux.browser_download_url
      },
      "darwin-universal": {
        signature: macSignature.trim(),
        url: mac.browser_download_url
      }
    }
  };
}

async function resolveRelease(repository, token) {
  if (process.env.GITHUB_EVENT_NAME === "release" && process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (event.release?.tag_name) {
      return githubJson(`https://api.github.com/repos/${repository}/releases/tags/${event.release.tag_name}`, token);
    }
  }

  return githubJson(`https://api.github.com/repos/${repository}/releases/latest`, token);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = args.output;
  if (!outputPath) {
    throw new Error("Missing required --output argument");
  }

  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is required");
  }

  const release = await resolveRelease(repository, token);
  const feed = await buildFeed(release, token);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
