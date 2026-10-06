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

test("a token refresh during discovery keeps the catalog, but an account switch does not", async (t) => {
  for (const switchAccount of [false, true]) {
    await t.test(switchAccount ? "switched" : "refreshed", async (subtest) => {
      let current = siwcAccount;
      const wizard = await startIsolatedWizard({ sessionToken, services: {
        async listAuthRegistrations() { return [current]; },
        async getSelectedRegistration() { return current.registrationId; },
        async getAuthStatus() { return { ...current, exists: true }; },
        async listSiwcModels() {
          // getAccessToken refresh writes a new generation; a switch selects another registration.
          current = { ...current, generation: "0b9c2f4e-6d1a-4c3b-9e8f-7a6b5c4d3e2f",
            ...(switchAccount ? { registrationId: "fixture_registration_2" } : {}) };
          return [{ slug: "listed-model", display_name: "Listed model" }];
        },
      } });
      subtest.after(() => wizard.close());
      const response = await fetch(`${wizard.origin}/api/siwc/models`, { headers: { "X-Setup-Token": sessionToken } });
      const body = await response.json();
      if (switchAccount) {
        assert.equal(response.status, 409);
        assert.equal(body.models, undefined);
      } else {
        assert.equal(response.status, 200);
        assert.equal(body.account.generation, current.generation);
        assert.deepEqual(body.models, [{ slug: "listed-model", display_name: "Listed model" }]);
      }
    });
  }
});
