import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SOCIAL_PREVIEW_SHA256 =
  "84538f14cb3c36cbf7708407eb07609ba4fb121589d170d3d4f674841b0a0985";

test("gateway android is the canonical logo across public surfaces", async () => {
  const [
    logo,
    roundedLogo,
    hostedIcon,
    hostedRoundedIcon,
    localIcon,
    localRoundedIcon,
    socialPreview,
    readme,
    npmReadme,
    brandGuide,
    metadata,
    webTopBar,
    localTopBarIcon,
    hostedTopBarIcon,
    ...wizardPages
  ] = await Promise.all([
    readFile("docs/images/brand/relmio-logo.png"),
    readFile("docs/images/brand/relmio-logo-rounded.svg", "utf8"),
    readFile("web/public/relmio-icon.png"),
    readFile("web/public/relmio-icon-rounded.svg", "utf8"),
    readFile("src/ui/relmio-icon.png"),
    readFile("src/ui/relmio-icon-rounded.svg", "utf8"),
    readFile("web/public/og.png"),
    readFile("README.md", "utf8"),
    readFile("npm/README.md", "utf8"),
    readFile("docs/brand.md", "utf8"),
    readFile("web/app/layout.tsx", "utf8"),
    readFile("web/app/components/ui/TopBar.tsx", "utf8"),
    readFile("src/ui/relmio-icon-96.png"),
    readFile("web/public/relmio-icon-96.png"),
    ...[
      "index.html",
      "local.html",
      "assistant.html",
      "supergrok-vps.html",
      "local-model-vps.html",
      "hosting.html",
    ].map((page) => readFile(`src/ui/${page}`, "utf8")),
  ]);

  assert.deepEqual(logo.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  assert.deepEqual(hostedIcon, logo);
  assert.deepEqual(localIcon, logo);
  assert.equal(hostedRoundedIcon, roundedLogo);
  assert.equal(localRoundedIcon, roundedLogo);
  assert.match(roundedLogo, /<clipPath id="rounded-square">/u);
  assert.deepEqual(
    socialPreview.subarray(0, PNG_SIGNATURE.length),
    PNG_SIGNATURE,
  );
  assert.equal(socialPreview.readUInt32BE(16), 1200);
  assert.equal(socialPreview.readUInt32BE(20), 630);
  assert.equal(
    createHash("sha256").update(socialPreview).digest("hex"),
    SOCIAL_PREVIEW_SHA256,
  );
  await Promise.all([
    assert.rejects(access("docs/images/brand/relmio-mark.svg"), {
      code: "ENOENT",
    }),
    assert.rejects(access("web/public/relmio-mark.svg"), { code: "ENOENT" }),
  ]);
  assert.ok(
    readme.indexOf('src="docs/images/brand/relmio-banner-animated.svg"') <
      readme.indexOf('<h1 align="center">Relmio</h1>'),
  );
  assert.match(
    npmReadme,
    /cdn\.jsdelivr\.net\/npm\/relmio@latest\/docs\/images\/brand\/relmio-banner-animated\.svg/u,
  );
  assert.match(readme, /Bring your AI sign-ins to your tools/u);
  assert.match(npmReadme, /alt="Animated Relmio mascot carrying a private n8n connection through its doorway"/u);
  assert.match(brandGuide, /images\/brand\/relmio-logo\.png/u);

  assert.match(metadata, /relmio-icon-rounded\.svg/u);
  assert.match(webTopBar, /src="\/relmio-icon-96\.png"/u);
  // The top bars draw the logo at 32 px, so they load a 96 px copy (3x) of the
  // master instead of the 512 px original.
  assert.deepEqual(localTopBarIcon.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  assert.equal(localTopBarIcon.readUInt32BE(16), 96);
  assert.equal(localTopBarIcon.readUInt32BE(20), 96);
  assert.deepEqual(hostedTopBarIcon, localTopBarIcon);
  assert.doesNotMatch(webTopBar, /relmio-mark\.svg/u);

  for (const source of wizardPages) {
    assert.match(source, /href="\/relmio-icon-rounded\.svg"/u);
    assert.match(
      source,
      /<img\s+class="rm-brand__logo"\s+src="\/relmio-icon-96\.png"\s+width="32"\s+height="32"\s+alt=""/u,
    );
    assert.doesNotMatch(source, /data:image\/svg\+xml/u);
  }
});

test("README makes the anti-bypass legal boundary prominent", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /## Legal/u);
  assert.match(
    readme,
    /> \[!WARNING\][\s\S]*> \*\*Do not bypass rate limits, restrictions, or safeguards\.\*\*/u,
  );
  assert.match(readme, /OpenAI's \[Terms of Use\]/u);
  assert.match(readme, /\[Usage Policies\]/u);
});
