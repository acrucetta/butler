import test from "node:test";
import assert from "node:assert/strict";

import { assertUpOwnerAllowed } from "./up-owner-guard.mjs";

test("allows when no required owner configured", () => {
  assert.doesNotThrow(() => assertUpOwnerAllowed({}));
});

test("allows when required owner matches actual owner", () => {
  assert.doesNotThrow(() =>
    assertUpOwnerAllowed({
      BUTLER_UP_OWNER_REQUIRED: "schtasks",
      BUTLER_UP_OWNER: "SCHTASKS"
    })
  );
});

test("throws when required owner is set but actual owner differs", () => {
  assert.throws(
    () =>
      assertUpOwnerAllowed({
        BUTLER_UP_OWNER_REQUIRED: "schtasks",
        BUTLER_UP_OWNER: "manual"
      }),
    /butler up blocked/i
  );
});

test("throws when required owner is set but actual owner missing", () => {
  assert.throws(
    () =>
      assertUpOwnerAllowed({
        BUTLER_UP_OWNER_REQUIRED: "schtasks"
      }),
    /required owner 'schtasks' but got 'unset'/i
  );
});
