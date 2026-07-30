import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("project pins the reviewed SSH dependency and Node runtime", async () => {
  const [packageContents, license, notice] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("LICENSE", "utf8"),
    readFile("NOTICE", "utf8"),
  ]);
  const packageJson = JSON.parse(packageContents);

  assert.equal(packageJson.engines.node, ">=22");
  assert.equal(packageJson.packageManager, "npm@10.9.8");
  assert.equal(packageJson.dependencies.ssh2, "1.17.0");
  assert.equal(packageJson.name, "relmio");
  assert.equal(packageJson.bin.relmio, "src/cli.js");
  assert.equal(packageJson.bin.planrelay, "src/cli.js");
  assert.equal(packageJson.bin["n8n-openai-oauth-setup"], "src/cli.js");
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.license, "Apache-2.0");
  assert.match(license, /Apache License/u);
  assert.doesNotMatch(license, /^MIT License$/mu);
  assert.match(license, /3\. Grant of Patent License\./u);
  assert.match(notice, /Evan Zhou and OpenAI OAuth contributors/u);
  assert.match(notice, /github\.com\/EvanZhouDev\/openai-oauth/u);
  assert.equal(
    packageJson.repository.url,
    "git+https://github.com/Demonbane18/relmio.git",
  );
  assert.equal(
    packageJson.bugs.url,
    "https://github.com/Demonbane18/relmio/issues",
  );
  assert.equal(packageJson.homepage, "https://relmio.vercel.app/");
});

test("double-click launchers only install local dependencies and start the wizard", async () => {
  const launchers = await Promise.all([
    readFile("Start Wizard.command", "utf8"),
    readFile("Start Wizard.bat", "utf8"),
  ]);

  for (const launcher of launchers) {
    assert.match(launcher, /versions\.node|node -p/);
    assert.match(launcher, />= 22|GEQ 22/);
    assert.match(launcher, /npm ci --ignore-scripts/);
    assert.match(launcher, /npm start/);
    assert.doesNotMatch(
      launcher,
      /\bdocker\b|\bssh\b|\bn8n\b.*(?:restart|stop|rm|up|build)/i,
    );
  }
});

test("shared ignore policy excludes local maintainer artifacts", async () => {
  const gitignore = await readFile(".gitignore", "utf8");

  assert.match(gitignore, /^\.codex-local-context\.md$/mu);
  assert.match(gitignore, /^graphify-out\/$/mu);
  assert.match(gitignore, /^\.release\/$/mu);
});

test("sanitized preview follows endpoint contracts without live OAuth", async () => {
  const preview = await readFile("scripts/preview.js", "utf8");

  assert.match(preview, /previewMode: true/u);
  assert.match(preview, /http:\/\/n8n-openai-oauth:10531\/v1/u);
  assert.doesNotMatch(preview, /auth\.openai\.com/u);
  assert.doesNotMatch(preview, /startOAuthLogin/u);
  assert.doesNotMatch(preview, /async runOAuthLogin\(\)/u);
});

test("CI pins reviewed actions and the repository npm version", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");

  assert.match(
    workflow,
    /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/u,
  );
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(
    workflow,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/u,
  );
  assert.match(workflow, /npm install --global --ignore-scripts npm@10\.9\.8/u);
  assert.match(workflow, /test "\$\(npm --version\)" = "10\.9\.8"/u);
});

test("trusted publishing uses short-lived GitHub OIDC credentials", async () => {
  const workflow = await readFile(".github/workflows/publish.yml", "utf8");

  assert.match(workflow, /release:\s*\n\s+types:\s*\n\s+- published/u);
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /environment: npm/u);
  assert.match(workflow, /node-version: "22\.14\.0"/u);
  assert.match(workflow, /npm@11\.13\.0/u);
  assert.match(workflow, /npm run package:build -- \.release/u);
  assert.match(workflow, /npm publish/u);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/u);
});

test("public README documents the latest npm walkthrough and sanitized images", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(
    readme,
    /npx --yes --ignore-scripts relmio@latest/u,
  );
  assert.match(readme, /docs\/images\/setup\/01-local-sign-in-ready\.png/u);
  assert.match(readme, /docs\/images\/setup\/05-bridge-ready\.png/u);
  assert.match(readme, /```mermaid/u);
  assert.match(readme, /Copy credential settings/u);
  assert.match(readme, /\[Changelog\]\(CHANGELOG\.md\)/u);
  assert.match(readme, /img\.shields\.io\/npm\/v\/relmio/u);
  assert.match(readme, /docs\/images\/brand\/relmio-mark\.svg/u);
  assert.match(readme, /https:\/\/relmio\.vercel\.app\//u);
  assert.doesNotMatch(readme, /relmio\.jpfusin\.tech/u);
  assert.match(readme, /## Known limitations/u);
  assert.match(readme, /## Legal/u);
});

test("README walkthrough images are metadata-free PNG files", async () => {
  const images = await Promise.all(
    [
      "01-local-sign-in-ready.png",
      "02-vps-identity-confirmed.png",
      "03-n8n-detected.png",
      "04-install-plan.png",
      "05-bridge-ready.png",
    ].map((name) => readFile(`docs/images/setup/${name}`)),
  );

  for (const image of images) {
    assert.deepEqual(
      [...image.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.equal(image.readUInt32BE(16), 1440);
    assert.ok(image.readUInt32BE(20) >= 1_000);

    const chunkTypes = [];
    let offset = 8;
    while (offset < image.length) {
      const length = image.readUInt32BE(offset);
      const type = image.toString("ascii", offset + 4, offset + 8);
      chunkTypes.push(type);
      offset += 12 + length;
    }
    assert.equal(offset, image.length);
    assert.equal(chunkTypes[0], "IHDR");
    assert.equal(chunkTypes.at(-1), "IEND");
    assert.ok(
      chunkTypes.every((type) => ["IHDR", "IDAT", "IEND"].includes(type)),
      `unexpected PNG metadata chunk: ${chunkTypes.join(", ")}`,
    );
  }
});

test("README relative links resolve to repository files", async () => {
  const readme = await readFile("README.md", "utf8");
  const targets = [...readme.matchAll(/\]\(([^)]+)\)/gu)].map(
    ([, target]) => target,
  );

  for (const target of targets) {
    const path = target.split("#", 1)[0];
    if (!path || /^https?:/u.test(path)) {
      continue;
    }
    await access(path);
  }
});

test("public-facing project files do not describe the repository as private", async () => {
  const files = await Promise.all(
    [
      "README.md",
      "docs/security.md",
      "docs/npm-publish.md",
      "tasks/plan.md",
      "tasks/todo.md",
      "src/ui/index.html",
    ].map(async (file) => [file, await readFile(file, "utf8")]),
  );

  for (const [file, contents] of files) {
    assert.doesNotMatch(
      contents,
      /\b(?:this|the) (?:GitHub )?repository is private\b|\bprivate MVP\b/u,
      file,
    );
  }
});
