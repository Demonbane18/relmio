import assert from "node:assert/strict";
import test from "node:test";
import { siwcAccount, startIsolatedWizard } from "./helpers/siwc-wizard.js";

const sessionToken = "catalog-test-session-token-123456789012345";

test("model choices follow selected account catalog order rather than synthetic image presets", async (t) => {
  const models = [{ slug: "account-model-z", display_name: "Account model Z" },
    { slug: "account-model-a", display_name: "Account model A" }];
  const wizard = await startIsolatedWizard({ sessionToken, services: {
    async listSiwcModels({ registrationId }) { assert.equal(registrationId, siwcAccount.registrationId); return models; },
  } });
  t.after(() => wizard.close());
  const response = await fetch(`${wizard.origin}/api/siwc/models`, { headers: { "X-Setup-Token": sessionToken } });
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.deepEqual(catalog.models, models);
  assert.equal(catalog.account.registrationId, siwcAccount.registrationId);
});

test("invalid catalog identifiers and missing plan permission cannot produce model choices", async (t) => {
  for (const invalidCatalog of [false, true]) {
    await t.test(String(invalidCatalog), async (subtest) => {
      let calls = 0;
      const wizard = await startIsolatedWizard({ sessionToken, services: {
        async listAuthRegistrations() { return [{ ...siwcAccount,
          planPermission: invalidCatalog ? "granted" : "not-granted" }]; },
        async listSiwcModels() { calls++; return [{ slug: "../../unsafe", display_name: "Unsafe" }]; },
      } });
      subtest.after(() => wizard.close());
      const response = await fetch(`${wizard.origin}/api/siwc/models`, { headers: { "X-Setup-Token": sessionToken } });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).models, undefined);
      assert.equal(calls, invalidCatalog ? 1 : 0);
    });
  }
});
