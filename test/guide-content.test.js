import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GUIDE_ERRORS } from "../src/ui/guide/errors.js";

const PAGES = {
  vps: "index.html",
  local: "local.html",
  assistant: "assistant.html",
  "supergrok-vps": "supergrok-vps.html",
  "local-model-vps": "local-model-vps.html",
  hosting: "hosting.html",
};
const ACTIONS = new Set(["type", "press", "choose", "check", "read", "wait"]);
const DONE = /^(filled|checked|clicked|changed|manual|(visible|hidden):(.+))$/u;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TAG = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/giu;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

// Builds a flat element list with parent links; enough for id/class/attribute/descendant selectors.
function parseHtml(html) {
  const root = { tag: "#root", attrs: new Map(), parent: null };
  const elements = [];
  let current = root;
  for (const [token, closing, rawTag, rawAttrs = ""] of html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, "").matchAll(TAG)) {
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (closing) {
      let node = current;
      while (node !== root && node.tag !== tag) node = node.parent;
      if (node !== root) current = node.parent;
      continue;
    }
    const attrs = new Map();
    for (const [, name, double, single, bare] of rawAttrs.matchAll(ATTR)) attrs.set(name.toLowerCase(), double ?? single ?? bare ?? "");
    const element = { tag, attrs, parent: current };
    elements.push(element);
    if (!VOID.has(tag) && !token.endsWith("/>")) current = element;
  }
  return elements;
}

// Supports compound selectors (tag, #id, .class, [attr], [attr=value]) joined by descendant
// spaces. Anything else throws, so content stays within selectors this test can verify.
function parseCompound(text) {
  const parts = { tag: null, checks: [] };
  const pattern = /^([a-z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\]/iuy;
  let index = 0;
  while (index < text.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (!match || match[0] === "") throw new Error(`Unsupported selector: ${text}`);
    const [, tag, id, className, attr, double, single, bare] = match;
    if (tag) {
      if (index !== 0) throw new Error(`Unsupported selector: ${text}`);
      parts.tag = tag.toLowerCase();
    } else if (id) parts.checks.push((element) => element.attrs.get("id") === id);
    else if (className) parts.checks.push((element) => (element.attrs.get("class") ?? "").split(/\s+/u).includes(className));
    else {
      const value = double ?? single ?? bare;
      parts.checks.push((element) => element.attrs.has(attr) && (value === undefined || element.attrs.get(attr) === value));
    }
    index = pattern.lastIndex;
  }
  return (element) => (!parts.tag || element.tag === parts.tag) && parts.checks.every((check) => check(element));
}

function matches(elements, selector) {
  const compounds = selector.trim().split(/\s+/u).map(parseCompound);
  const last = compounds.pop();
  return elements.some((element) => {
    if (!last(element)) return false;
    let ancestor = element.parent;
    for (let index = compounds.length - 1; index >= 0; index -= 1) {
      while (ancestor && !(ancestor.tag !== "#root" && compounds[index](ancestor))) ancestor = ancestor.parent;
      if (!ancestor) return false;
      ancestor = ancestor.parent;
    }
    return true;
  });
}

function strings(value, path = "") {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
  return [];
}

const words = (text) => text.trim().split(/\s+/u).length;
const sentences = (text) => (text.match(/[.?](?=\s|$)/gu) ?? []).length;
const pages = Object.fromEntries(await Promise.all(Object.entries(PAGES).map(async ([page, file]) =>
  [page, parseHtml(await readFile(new URL(`../src/ui/${file}`, import.meta.url), "utf8"))])));
const guides = Object.fromEntries(await Promise.all(Object.keys(PAGES).map(async (page) =>
  [page, (await import(`../src/ui/guide/content-${page}.js`)).GUIDE])));

function assertSelector(page, selector, where) {
  assert.equal(typeof selector, "string", `${where} needs a selector`);
  assert.ok(matches(pages[page], selector), `${where}: "${selector}" matches nothing in ${PAGES[page]}`);
}

function assertEntry(entry, where) {
  assert.ok(entry.title?.trim() && words(entry.title) <= 8, `${where} title`);
  assert.ok(entry.say?.trim() && sentences(entry.say) >= 1 && sentences(entry.say) <= 3, `${where} say`);
  assert.ok(Array.isArray(entry.steps) && entry.steps.length > 0 && entry.steps.every((step) => step.trim()), `${where} steps`);
  for (const [page, selector] of Object.entries(entry.targets ?? {})) {
    assert.ok(Object.hasOwn(PAGES, page), `${where} targets unknown page ${page}`);
    assertSelector(page, selector, `${where}.targets.${page}`);
  }
}

for (const [page, guide] of Object.entries(guides)) {
  test(`${page} guide points only at elements in ${PAGES[page]}`, () => {
    assert.equal(guide.page, page);
    assert.ok(guide.title.trim() && guide.intro.trim());
    const body = pages[page].find((element) => element.tag === "body");
    if (body.attrs.has("data-guide-page")) assert.equal(body.attrs.get("data-guide-page"), page);
    assert.ok(guide.chapters.length > 0);
    const chapterIds = new Set();
    const tipIds = new Set();
    for (const chapter of guide.chapters) {
      const where = `${page}/${chapter.id}`;
      assert.match(chapter.id, /^[a-z0-9-]+$/u, where);
      assert.ok(!chapterIds.has(chapter.id), `${where} repeats a chapter id`);
      chapterIds.add(chapter.id);
      assert.ok(words(chapter.label) >= 2 && words(chapter.label) <= 5, `${where} label needs 2 to 5 words`);
      assert.ok(chapter.badge?.trim(), `${where} badge`);
      assertSelector(page, chapter.panel, `${where} panel`);
      assert.ok(chapter.tips.length > 0, `${where} has no tips`);
      for (const tip of chapter.tips) {
        const tipWhere = `${where}/${tip.id}`;
        assert.match(tip.id, /^[a-z0-9-]+$/u, tipWhere);
        assert.ok(!tipIds.has(tip.id), `${tipWhere} repeats a tip id`);
        tipIds.add(tip.id);
        assertSelector(page, tip.target, `${tipWhere} target`);
        assert.ok(ACTIONS.has(tip.action), `${tipWhere} action`);
        assert.ok(tip.title.trim() && words(tip.title) <= 6, `${tipWhere} title needs at most 6 words`);
        assert.ok(sentences(tip.say) >= 1 && sentences(tip.say) <= 3, `${tipWhere} say needs 1 to 3 sentences`);
        for (const key of ["example", "find"]) {
          if (key in tip) assert.ok(typeof tip[key] === "string" && tip[key].trim(), `${tipWhere} ${key}`);
        }
        const done = DONE.exec(tip.done);
        assert.ok(done, `${tipWhere} done`);
        if (done[3]) assertSelector(page, done[3], `${tipWhere} done`);
      }
    }
    assert.ok(guide.finish.title.trim() && guide.finish.say.trim());
    assert.ok(guide.finish.next.length > 0 && guide.finish.next.every((step) => step.trim()));
  });
}

test("error help covers every recovery code and the codes pages branch on", async () => {
  const server = await readFile(new URL("../src/web/server.js", import.meta.url), "utf8");
  const set = /const SIWC_RECOVERY = new Set\(\[([^\]]+)\]\)/u.exec(server);
  assert.ok(set, "SIWC_RECOVERY not found in server.js");
  const recovery = [...set[1].matchAll(/"([^"]+)"/gu)].map(([, code]) => code);
  assert.ok(recovery.length >= 9);
  for (const code of recovery) assertEntry(GUIDE_ERRORS.recovery[code] ?? {}, `recovery.${code}`);
  for (const [code, entry] of Object.entries(GUIDE_ERRORS.recovery)) {
    assert.ok(recovery.includes(code), `recovery.${code} is not in SIWC_RECOVERY`);
    assertEntry(entry, `recovery.${code}`);
  }
  const required = [
    "NO_RUNNING_N8N", "ssh_identity_review_required", "subscription_sharing_usage_limit_exceeded",
    "retryBlocked", "remoteOutcomeUnknown", "managedPartialStack",
    "usage_limit", "reauthorize", "probe_rejected", "checks_off", "time_limit", "lease_unavailable",
    "catalog_unavailable", "registration_unavailable",
  ];
  const acquisition = await readFile(new URL("../src/local-model/acquisition.mjs", import.meta.url), "utf8");
  const modelErrors = /const ERROR_CODES = new Set\(\[([^\]]+)\]\)/u.exec(acquisition);
  assert.ok(modelErrors, "ERROR_CODES not found in acquisition.mjs");
  required.push(...[...modelErrors[1].matchAll(/"([^"]+)"/gu)].map(([, code]) => code));
  for (const code of required) assert.ok(GUIDE_ERRORS.codes[code], `codes.${code} is missing`);
  for (const [code, entry] of Object.entries(GUIDE_ERRORS.codes)) assertEntry(entry, `codes.${code}`);
  for (const status of ["400", "401", "403", "404", "409", "429", "500", "502", "503"]) {
    assert.ok(GUIDE_ERRORS.status[status], `status.${status} is missing`);
  }
  for (const [status, entry] of Object.entries(GUIDE_ERRORS.status)) assertEntry(entry, `status.${status}`);
  assertEntry(GUIDE_ERRORS.fallback, "fallback");
});

test("guide copy follows the brand voice and uses documentation-safe values", () => {
  for (const [name, value] of [...Object.entries(guides), ["errors", GUIDE_ERRORS]]) {
    for (const [path, text] of strings(value)) {
      assert.doesNotMatch(text, /[!\u2013\u2014]|\p{Extended_Pictographic}/u, `${name}${path} has an exclamation mark, dash or emoji`);
      for (const [address] of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu)) {
        assert.ok(address.startsWith("203.0.113.") || address === "127.0.0.1", `${name}${path} uses a real-looking address ${address}`);
      }
    }
  }
});

test("selector checks catch a renamed element", () => {
  assert.ok(matches(pages.vps, "#vps-form #host"));
  assert.ok(!matches(pages.vps, "#vps-form #hots"));
  assert.ok(matches(pages["supergrok-vps"], "#settings-panel [data-action=sign-in]"));
  assert.ok(!matches(pages["supergrok-vps"], "#ssh-panel [data-action=sign-in]"));
  assert.throws(() => matches(pages.vps, "#host:focus"), /Unsupported selector/u);
});
