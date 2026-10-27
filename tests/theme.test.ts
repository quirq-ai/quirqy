import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { THEME_BOOTSTRAP, THEME_STORAGE_KEY, themePreference } from "../lib/theme";

function boot(saved: string | null, systemDark: boolean, storageBlocked = false) {
  const dataset: Record<string, string> = {};
  runInNewContext(THEME_BOOTSTRAP, {
    document: { documentElement: { dataset } },
    localStorage: { getItem(key: string) {
      assert.equal(key, THEME_STORAGE_KEY);
      if (storageBlocked) throw new Error("Storage unavailable");
      return saved;
    } },
    matchMedia(query: string) {
      assert.equal(query, "(prefers-color-scheme: dark)");
      return { matches: systemDark };
    }
  });
  return dataset;
}

test("pre-paint theme follows the OS when no explicit preference exists", () => {
  assert.deepEqual(boot(null, false), { theme: "light", themePreference: "system" });
  assert.deepEqual(boot(null, true), { theme: "dark", themePreference: "system" });
  assert.deepEqual(boot("system", true), { theme: "dark", themePreference: "system" });
});

test("saved explicit themes override the OS before hydration", () => {
  assert.deepEqual(boot("dark", false), { theme: "dark", themePreference: "dark" });
  assert.deepEqual(boot("light", true), { theme: "light", themePreference: "light" });
});

test("unrecognized stored values fall back to the system preference", () => {
  for (const saved of ["", "DARK", "unknown", "null"]) {
    assert.deepEqual(boot(saved, true), { theme: "dark", themePreference: "system" });
  }
});

test("blocked browser storage does not prevent initial theme application", () => {
  assert.deepEqual(boot(null, true, true), { theme: "dark", themePreference: "system" });
});

test("live preference validation accepts supported values and rejects malformed input", () => {
  assert.equal(themePreference("light"), "light");
  assert.equal(themePreference("dark"), "dark");
  for (const value of ["system", "unknown", undefined, null, {}, 1]) assert.equal(themePreference(value), "system");
});
