import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// pnpm forwards a literal "--" separator to the script; npm strips it. Accept both.
const outputArgument = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
const outputRoot = outputArgument === undefined ? undefined : resolve(outputArgument);
const textExtensions = new Set([".cjs", ".css", ".html", ".json", ".md", ".mjs", ".py", ".sql", ".toml", ".ts", ".tsx", ".txt", ".yml", ".yaml"]);
const requiredPaths = [
  ".env.example", "LICENSE", "README.md", "index.html", "package.json", "pnpm-lock.yaml", "src/App.tsx",
  "content/balance.v2.json", "public/site.webmanifest", "scripts/create-public-export.mjs",
  "supabase/public/migrations/20260908080000_public_bootstrap.sql",
  "supabase/public/migrations/20260925090000_realtime_publication.sql",
  "supabase/public/migrations/20260925100000_balance_v2_question_range.sql", "scripts/test-balance-catalog-db.py",
];

const fail = (message) => {
  console.error(`Public export failed: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
};

const exists = async (path) => stat(path).then(() => true).catch(() => false);
const sourcePath = (...parts) => resolve(sourceRoot, ...parts);
const outputPath = (...parts) => resolve(outputRoot, ...parts);
const parent = async (path) => mkdir(dirname(path), { recursive: true });

// Real people's names from the private roster seed must never reach the export. They are read
// at export time from this private checkout and never written into this file; a public clone has
// no seed, so the check is empty there. Each name also blocks its "surname given" and given-only forms.
async function privateRosterTerms() {
  const directory = sourcePath("supabase/migrations");
  if (!await exists(directory)) return [];
  const terms = new Set();
  for (const file of (await readdir(directory)).filter((name) => /seed.*\.sql$/u.test(name))) {
    const text = await readFile(resolve(directory, file), "utf8");
    for (const [, name] of text.matchAll(/\(\s*\d+,\s*'([가-힣]{2,4})'/gu)) {
      terms.add(name);
      terms.add(`${name[0]} ${name.slice(1)}`);
      if (name.length >= 3) terms.add(name.slice(1));
    }
  }
  return [...terms];
}

// Terms that identify the original community live in a private file that is never exported, so
// neither the list nor its terms can reach a public copy of this script. The private checkout
// (recognised by its event migration history) must have the file; a public clone needs none.
async function privateDenylist() {
  const path = sourcePath("docs/public-release/export-denylist.txt");
  if (!await exists(path)) {
    if (await exists(sourcePath("supabase/migrations"))) fail("private deny list is missing: docs/public-release/export-denylist.txt");
    return [];
  }
  return (await readFile(path, "utf8")).split("\n").map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// Identifiers of this private project's own services, read at export time from files that are
// never exported (Figma state, Supabase link state, Vercel link). A public clone has none of them.
async function privateServiceIdentifiers() {
  const read = async (path) => (await exists(sourcePath(path)) ? readFile(sourcePath(path), "utf8") : null);
  const identifiers = [];
  const figmaState = await read("docs/design-review/say-on-figma-state.json");
  const figmaFile = figmaState ? JSON.parse(figmaState).file : null;
  const figmaKey = typeof figmaFile === "string" ? figmaFile.match(/[A-Za-z0-9]{22,}/u)?.[0] : null;
  if (figmaKey) identifiers.push(figmaKey);
  const supabaseRef = (await read("supabase/.temp/project-ref"))?.trim();
  if (supabaseRef) identifiers.push(supabaseRef);
  const vercelLink = await read(".vercel/project.json");
  if (vercelLink) {
    const { projectId, orgId } = JSON.parse(vercelLink);
    identifiers.push(...[projectId, orgId].filter((value) => typeof value === "string" && value.length > 0));
  }
  return identifiers;
}

async function copyFile(relativePath) {
  const from = sourcePath(relativePath);
  const to = outputPath(relativePath);
  if (!await exists(from)) fail(`allow-listed source is missing: ${relativePath}`);
  await parent(to);
  await cp(from, to, { force: false, errorOnExist: true });
}

async function copyTree(relativePath) {
  const from = sourcePath(relativePath);
  const to = outputPath(relativePath);
  if (!await exists(from)) fail(`allow-listed tree is missing: ${relativePath}`);
  await parent(to);
  await cp(from, to, { recursive: true, force: false, errorOnExist: true });
}

async function walk(root, visitor) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) await walk(path, visitor);
    else if (entry.isFile()) await visitor(path);
  }
}

async function copyMatching(relativeDirectory, predicate) {
  const from = sourcePath(relativeDirectory);
  if (!await exists(from)) fail(`allow-listed tree is missing: ${relativeDirectory}`);
  await walk(from, async (path) => {
    const sourceRelative = relative(sourceRoot, path);
    if (!predicate(sourceRelative)) return;
    await copyFile(sourceRelative);
  });
}

async function writePublicPackage() {
  const packagePath = sourcePath("package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.private = false;
  packageJson.scripts = {
    dev: packageJson.scripts.dev,
    build: packageJson.scripts.build,
    preview: packageJson.scripts.preview,
    test: packageJson.scripts.test,
    "validate:balance": "node scripts/validate-balance-catalog.mjs content/balance.v2.json",
    "capacity:rehearsal": packageJson.scripts["capacity:rehearsal"],
    "export:public": "node scripts/create-public-export.mjs",
  };
  await writeFile(outputPath("package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

async function writePublicReadme() {
  const template = await readFile(sourcePath("docs/public-release/README.md"), "utf8");
  await writeFile(outputPath("README.md"), template, "utf8");
}

async function validateOutput() {
  for (const path of requiredPaths) if (!await exists(outputPath(path))) fail(`required output is missing: ${path}`);
  for (const blockedPath of [".git", "node_modules", "dist", ".env.local"]) {
    if (await exists(outputPath(blockedPath))) fail(`blocked output exists: ${blockedPath}`);
  }

  const balanceArtDirectory = outputPath("public/images/say-on/balance-v4");
  const balanceArt = (await readdir(balanceArtDirectory)).filter((file) => file.endsWith(".webp"));
  if (balanceArt.length !== 120) fail(`expected 120 individual Balance choice assets, found ${balanceArt.length}`);

  const violations = [];
  const forbiddenTerms = await privateDenylist();
  const privateTerms = [...await privateRosterTerms(), ...await privateServiceIdentifiers()];
  await walk(outputRoot, async (path) => {
    const outputRelative = relative(outputRoot, path);
    const extension = extname(path).toLowerCase();
    const shouldRead = textExtensions.has(extension) || [".env.example", ".gitignore", ".npmrc"].includes(outputRelative);
    const fileNameViolation = forbiddenTerms.find((term) => outputRelative.toLowerCase().includes(term));
    if (fileNameViolation) violations.push(`${outputRelative}: forbidden path term`);
    if (privateTerms.some((term) => outputRelative.includes(term))) violations.push(`${outputRelative}: private name or identifier in path`);
    if (!shouldRead) return;
    const text = await readFile(path, "utf8");
    const contentViolation = forbiddenTerms.find((term) => text.toLowerCase().includes(term));
    if (contentViolation) violations.push(`${outputRelative}: forbidden content term`);
    // Report the file only; printing the matched name would leak it into logs.
    if (privateTerms.some((term) => text.includes(term))) violations.push(`${outputRelative}: private name or identifier`);
  });
  if (violations.length) fail(`identity scan found ${violations.join(", ")}`);

  // Every relative Markdown link or image in the export must resolve inside the export.
  const brokenLinks = [];
  await walk(outputRoot, async (path) => {
    if (extname(path).toLowerCase() !== ".md") return;
    const text = await readFile(path, "utf8");
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/gu), ...text.matchAll(/\bsrc="([^"]+)"/gu)].map((match) => match[1]);
    for (const target of targets) {
      const file = target.split("#")[0];
      if (file === "" || /^[a-z][a-z0-9+.-]*:/iu.test(file)) continue;
      if (!await exists(resolve(dirname(path), file))) brokenLinks.push(`${relative(outputRoot, path)} -> ${file}`);
    }
  });
  if (brokenLinks.length) fail(`broken relative links: ${brokenLinks.join(", ")}`);

  const exportedPackage = JSON.parse(await readFile(outputPath("package.json"), "utf8"));
  if (exportedPackage.private !== false) fail("output package must be publishable");
  for (const [name, command] of Object.entries(exportedPackage.scripts)) {
    const match = typeof command === "string" ? command.match(/scripts\/([\w.-]+\.(?:mjs|cjs|js))/u) : null;
    if (match && !await exists(outputPath("scripts", match[1]))) fail(`script '${name}' references a missing file`);
  }
}

if (outputRoot === undefined || process.argv.includes("--help")) {
  console.log("Usage: node scripts/create-public-export.mjs <new-empty-output-directory>");
  process.exit(outputRoot === undefined ? 1 : 0);
}

if (outputRoot === sourceRoot || outputRoot.startsWith(`${sourceRoot}${sep}`)) fail("output must be outside the source checkout");
if (await exists(outputRoot)) fail("output directory must not already exist");

await mkdir(outputRoot, { recursive: true });

for (const path of [
  ".env.example", ".gitignore", ".npmrc", "LICENSE", "index.html", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vercel.json", "vite.config.ts",
  "content/balance-launch.ko.json", "content/balance.v2.json", "content/icebreaker.v2.json", "public/site.webmanifest",
  "src/assets/say-on-card-materials-v1.webp", "public/images/say-on/favicon-master-v1.png", "public/images/say-on/favicon-v1-32.png",
  "public/images/say-on/favicon-v1-192.png", "public/images/say-on/apple-touch-icon-v1.png", "public/images/say-on/shared-table-cutout-v1.webp",
  "public/images/say-on/balance-choice-ritual-v1.png", "scripts/validate-balance-catalog.mjs", "scripts/capacity-rehearsal.mjs",
  "scripts/create-public-export.mjs", "scripts/test-balance-catalog-db.py", "scripts/rehearsal_concurrency.py",
  "scripts/rehearsal-multi-client.cjs", "docs/design-review/asset-provenance.md",
]) await copyFile(path);

await copyMatching("src", (path) => [".ts", ".tsx", ".css"].includes(extname(path)));
for (const path of [
  "src/assets/cards/backgrounds-webp", "src/assets/card-back-stickers-webp", "public/images/say-on/icebreaker",
  "public/images/say-on/balance-v4", "supabase/public/migrations", "supabase/public/tests", "tests",
]) await copyTree(path);
await copyMatching("public/brand", (path) => extname(path) === ".webp");

await writePublicPackage();
await writePublicReadme();
await validateOutput();
console.log(JSON.stringify({ status: "pass", output: outputRoot, balanceChoiceAssets: 120, package: "standalone" }, null, 2));
