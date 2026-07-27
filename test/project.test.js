import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project pins the reviewed SSH dependency and Node runtime", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.engines.node, ">=22");
  assert.equal(packageJson.dependencies.ssh2, "1.17.0");
  assert.equal(packageJson.private, true);
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
