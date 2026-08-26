import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("gateway android is the canonical logo across public surfaces", async () => {
  const [
    logo,
    hostedIcon,
    localIcon,
    readme,
    npmReadme,
    brandGuide,
    metadata,
    hostedPage,
    installPage,
    n8nWizard,
    localWizard,
  ] = await Promise.all([
    readFile("docs/images/brand/relmio-logo.png"),
    readFile("web/public/relmio-icon.png"),
    readFile("src/ui/relmio-icon.png"),
    readFile("README.md", "utf8"),
    readFile("npm/README.md", "utf8"),
    readFile("docs/brand.md", "utf8"),
    readFile("web/app/layout.tsx", "utf8"),
    readFile("web/app/page.tsx", "utf8"),
    readFile("web/app/install/page.tsx", "utf8"),
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/local.html", "utf8"),
  ]);

  assert.deepEqual(logo.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  assert.deepEqual(hostedIcon, logo);
  assert.deepEqual(localIcon, logo);
  assert.ok(
    readme.indexOf('src="docs/images/brand/relmio-logo.png"') <
      readme.indexOf("# Relmio"),
  );
  assert.match(
    npmReadme,
    /cdn\.jsdelivr\.net\/npm\/relmio@latest\/docs\/images\/brand\/relmio-logo\.png/u,
  );
  assert.match(brandGuide, /images\/brand\/relmio-logo\.png/u);

  for (const source of [metadata, hostedPage, installPage]) {
    assert.match(source, /relmio-icon\.png/u);
    assert.doesNotMatch(source, /relmio-mark\.svg/u);
  }

  for (const source of [n8nWizard, localWizard]) {
    assert.match(source, /href="\/relmio-icon\.png"/u);
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
