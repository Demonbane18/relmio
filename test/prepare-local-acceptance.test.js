import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { directoryLinkType } from "./helpers/symlink-fixture.js";

test("local acceptance evidence stays outside the resolved checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relmio-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, "qa", "windows"), { recursive: true });
  await mkdir(join(checkout, "qa", "acceptance"));
  const script = join(checkout, "qa", "windows", "prepare-local-acceptance.mjs");
  await copyFile(new URL("../qa/windows/prepare-local-acceptance.mjs", import.meta.url), script);
  await copyFile(new URL("../qa/acceptance/relmio-release-acceptance.json", import.meta.url),
    join(checkout, "qa", "acceptance", "relmio-release-acceptance.json"));
  const link = join(root, "linked-checkout");
  await symlink(checkout, link, directoryLinkType);
  const cases = [
    ["missing argument", undefined, false],
    ["checkout root", checkout, false],
    ["ordinary descendant", join(checkout, "evidence"), false],
    ["two-dot name inside checkout", join(checkout, "..evidence"), false],
    ["checkout symlink", link, false],
    ["missing parents below symlink", join(link, "new", "nested"), false],
    ["parent itself", root, true],
    ["two-dot name outside checkout", join(root, "..evidence"), true],
    ["missing outside parents", join(root, "outside", "nested"), true],
  ];
  for (const [name, destination, allowed] of cases) {
    await t.test(name, async () => {
      const result = spawnSync(process.execPath, [script, ...(destination ? [destination] : [])], { encoding: "utf8" });
      assert.ifError(result.error);
      if (!allowed) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Provide an evidence directory outside the checkout/u);
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      const file = join(destination, "relmio-release-acceptance-local-model.json");
      const workflow = JSON.parse(await readFile(file, "utf8"));
      assert.equal(workflow.active, false);
      assert.equal(workflow.nodes.some((node) => node.credentials), false);
    });
  }
});
