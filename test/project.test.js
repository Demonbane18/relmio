import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const maximumReadmeImageDimension = 10_000;

function assertMetadataFreeReadmePng(image, name) {
  assert.ok(image.length >= 33, `${name} is too short to be a PNG`);
  assert.deepEqual([...image.subarray(0, 8)], pngSignature, `${name} signature`);
  assert.equal(image.readUInt32BE(8), 13, `${name} IHDR length`);
  assert.equal(image.toString("ascii", 12, 16), "IHDR", `${name} IHDR type`);

  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  assert.ok(
    width >= 1 && width <= maximumReadmeImageDimension,
    `${name} has an unreasonable width: ${width}`,
  );
  assert.ok(
    height >= 1 && height <= maximumReadmeImageDimension,
    `${name} has an unreasonable height: ${height}`,
  );

  const chunkTypes = [];
  let offset = 8;
  while (offset < image.length) {
    assert.ok(offset + 12 <= image.length, `${name} has a truncated PNG chunk`);
    const length = image.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    assert.ok(chunkEnd <= image.length, `${name} has an oversized PNG chunk`);
    chunkTypes.push(image.toString("ascii", offset + 4, offset + 8));
    offset = chunkEnd;
  }

  assert.equal(offset, image.length, `${name} PNG length`);
  assert.equal(chunkTypes[0], "IHDR", `${name} first PNG chunk`);
  assert.equal(chunkTypes.at(-1), "IEND", `${name} final PNG chunk`);
  assert.ok(
    chunkTypes.every((type) => ["IHDR", "IDAT", "IEND"].includes(type)),
    `${name} has unexpected PNG metadata chunks: ${chunkTypes.join(", ")}`,
  );
}

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
  const [workflow, maintainerGuide] = await Promise.all([
    readFile(".github/workflows/publish.yml", "utf8"),
    readFile("docs/npm-publish.md", "utf8"),
  ]);

  assert.match(workflow, /release:\s*\n\s+types:\s*\n\s+- published/u);
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /environment: npm/u);
  assert.match(workflow, /node-version: "22\.14\.0"/u);
  assert.match(workflow, /npm@11\.13\.0/u);
  assert.match(workflow, /npm run package:build -- \.release/u);
  assert.match(workflow, /npm publish/u);
  assert.match(workflow, /package-managers:[\s\S]*needs:[\s\S]*- publish/u);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/package-manager-candidates\.yml/u);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/u);
  assert.match(maintainerGuide, /GitHub OIDC/u);
  assert.match(maintainerGuide, /Never run `npm publish` locally/u);
  assert.doesNotMatch(
    maintainerGuide,
    /NPM_CREATE_ACCESS_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|^npm (?:login|whoami|publish)\b/mu,
  );
});

test("hosted CMD installer is checked out with Windows line endings", async () => {
  const attributes = await readFile(".gitattributes", "utf8");
  assert.match(attributes, /^web\/public\/install\.cmd text eol=crlf$/mu);
});

test("package-manager workflow builds review artifacts before release publication", async () => {
  const workflow = await readFile(
    ".github/workflows/package-manager-candidates.yml",
    "utf8",
  );

  assert.match(workflow, /pull_request:/u);
  assert.match(workflow, /workflow_call:[\s\S]*release_tag:/u);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/u);
  const wingetValidation = workflow.match(/^\s*winget validate [^\r\n]+$/mu);
  assert.ok(wingetValidation, "expected WinGet validation command");
  assert.equal(
    wingetValidation[0].trim(),
    String.raw`winget validate --disable-interactivity --ignore-warnings ".package-manager\candidates\winget-pkgs\manifests\d\Demonbane18\Relmio\$version"`,
  );
  assert.match(workflow, /relmio\.exe"\) --version/u);
  assert.match(workflow, /RedirectStandardOutput = \$true[\s\S]*?needs an interactive terminal/u);
  assert.match(workflow, /RequiredVersion \$moduleVersion/u);
  assert.match(workflow, /moduleVersion = "1\.12\.440"/u);
  const checksumMatchInvocation = workflow.match(
    /\[regex\]::Match\(([\s\S]*?)\n\s*\)/u,
  );
  assert.ok(checksumMatchInvocation, "expected checksum regex invocation");
  assert.doesNotMatch(
    checksumMatchInvocation[1],
    /,\s*$/u,
    "PowerShell multiline calls must not have a trailing comma",
  );
  const windowsArtifactUpload = workflow.match(
    /name: Seal reviewed package-manager candidates[\s\S]*?(?=\n\s+- name: Validate generated WinGet manifests)/u,
  );
  assert.ok(windowsArtifactUpload, "expected Windows artifact upload block");
  assert.match(
    windowsArtifactUpload[0],
    /path:\s*\|[\s\S]*?\.package-manager\/candidates\/[\s\S]*?include-hidden-files:\s*true/u,
  );
  const homebrewArtifactUpload = workflow.match(
    /name: Upload the registry-derived formula candidate[\s\S]*?(?=\n\s+publish-release-assets:)/u,
  );
  assert.ok(homebrewArtifactUpload, "expected Homebrew artifact upload block");
  assert.match(
    homebrewArtifactUpload[0],
    /path:\s+\.homebrew-release-candidate\/homebrew-tap\/Formula\/relmio\.rb[\s\S]*?include-hidden-files:\s*true/u,
  );
  assert.ok(
    workflow.indexOf("Seal reviewed package-manager candidates") <
      workflow.indexOf("Install-Module -Name Microsoft.WinGet.Client"),
  );
  assert.match(workflow, /registry\.npmjs\.org\/relmio\/-\/\$\{tarball\}/u);
  assert.match(workflow, /publish-release-assets:[\s\S]*contents: write/u);
  assert.match(workflow, /gh release upload/u);
  assert.doesNotMatch(workflow, /pull_request_target/u);

  const actionReferences = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/gu)];
  assert.ok(actionReferences.length >= 4);
  for (const [, reference] of actionReferences) {
    assert.match(reference, /^[a-f0-9]{40}$/u);
  }
});

test("public README is a concise entry point to hosted canonical docs", async () => {
  const [readme, gettingStarted, reference] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("docs/getting-started.md", "utf8"),
    readFile("docs/reference.md", "utf8"),
  ]);

  assert.match(readme, /npx --yes --ignore-scripts relmio@latest/u);
  assert.match(readme, /## Pick a path/u);
  assert.match(readme, /## Legal/u);
  assert.match(readme, /https:\/\/relmio\.vercel\.app\/docs\/getting-started/u);
  assert.match(readme, /https:\/\/relmio\.vercel\.app\/docs\/reference/u);
  assert.doesNotMatch(readme, /```mermaid|relmio\.jpfusin\.tech/u);
  assert.match(gettingStarted, /ChatGPT sign-in is never converted/u);
  assert.match(reference, /--remote-auth-token-env/u);
  assert.match(reference, /conversationId/u);
});

test("README walkthrough and proof images are metadata-free PNG files", async () => {
  const paths = [
    "docs/images/setup/00-install-methods.png",
    "docs/images/setup/01-local-sign-in-ready.png",
    "docs/images/setup/02-vps-identity-confirmed.png",
    "docs/images/setup/03-n8n-detected.png",
    "docs/images/setup/04-install-plan.png",
    "docs/images/setup/05-bridge-ready.png",
    "docs/images/examples/gpt-56-ai-agent-luna-run.png",
    "docs/images/examples/gpt-56-ai-agent-sol-run.png",
    "docs/images/examples/gpt-56-ai-agent-workflow.png",
    "docs/images/examples/gpt-56-luna-chat-model-run.png",
    "docs/images/examples/gpt-56-sol-chat-model-run.png",
    "docs/images/examples/hosted-chat-connected.png",
    "docs/images/examples/sidecar-docker-containers-running.png",
    "docs/images/examples/telegram-model-results.png",
    "docs/images/examples/telegram-n8n-workflow-execution.png",
    "docs/images/examples/gpt-56-model-selector.png",
    "docs/images/examples/n8n-openai-credential-connected.png",
  ];
  const images = await Promise.all(paths.map((path) => readFile(path)));

  for (const [index, image] of images.entries()) {
    assertMetadataFreeReadmePng(image, paths[index]);
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
