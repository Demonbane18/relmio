import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SOCIAL_PREVIEW_SHA256 =
  "2e9101fd535776a6b2c3866e914bc09ec2e00d6a14b118e63a9de0a73bc7a8b7";

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
    hostedPage,
    installPage,
    n8nWizard,
    localWizard,
    assistantWizard,
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
    readFile("web/app/page.tsx", "utf8"),
    readFile("web/app/install/page.tsx", "utf8"),
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/assistant.html", "utf8"),
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
  assert.match(readme, /One wizard\. Clear boundaries/u);
  assert.match(npmReadme, /One wizard with separate supported API and private experimental routes/iu);
  assert.match(brandGuide, /images\/brand\/relmio-logo\.png/u);
  assert.match(metadata, /new URL\("\/og\.png", metadataBase\)/u);
  assert.match(metadata, /width: 1200, height: 630/u);

  assert.match(metadata, /relmio-icon-rounded\.svg/u);
  for (const source of [hostedPage, installPage]) {
    assert.match(source, /relmio-icon\.png/u);
    assert.doesNotMatch(source, /relmio-mark\.svg/u);
  }

  for (const source of [n8nWizard, localWizard, assistantWizard]) {
    assert.match(source, /href="\/relmio-icon-rounded\.svg"/u);
    assert.match(
      source,
      /<img\s+class="brand-mark"\s+src="\/relmio-icon\.png"\s+alt=""\s+width="28"\s+height="28"/u,
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
