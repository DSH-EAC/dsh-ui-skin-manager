import assert from "node:assert/strict";
import test from "node:test";

import {isValidRange, isValidVersion, normalizeRange, parseVersion, satisfiesVersion} from "../src/index.ts";

test("a caret range over a zero major pins the next non-zero component", () => {
  assert.equal(satisfiesVersion("0.3.0", "^0.3.0"), true);
  assert.equal(satisfiesVersion("0.3.9", "^0.3.0"), true);
  assert.equal(satisfiesVersion("0.4.0", "^0.3.0"), false);
  assert.equal(satisfiesVersion("1.0.0", "^0.3.0"), false);
  assert.equal(satisfiesVersion("1.9.9", "^1.0.0"), true);
  assert.equal(satisfiesVersion("2.0.0", "^1.0.0"), false);
  assert.equal(satisfiesVersion("0.0.4", "^0.0.3"), false);
  assert.equal(satisfiesVersion("0.0.3", "^0.0.3"), true);
});

test("every declared comparator in a compound range is enforced", () => {
  assert.equal(satisfiesVersion("1.5.0", ">=1.0.0 <2.0.0"), true);
  assert.equal(satisfiesVersion("2.0.0", ">=1.0.0 <2.0.0"), false);
  assert.equal(satisfiesVersion("5.0.0", ">=1.0.0 <2.0.0"), false);
  assert.equal(satisfiesVersion("0.9.0", ">=1.0.0 <2.0.0"), false);
  assert.equal(satisfiesVersion("1.2.3", ">1.0.0 <=1.2.3"), true);
  assert.equal(satisfiesVersion("1.2.4", ">1.0.0 <=1.2.3"), false);
});

test("alternation is evaluated per clause set", () => {
  assert.equal(satisfiesVersion("0.4.0", "^0.3.0 || ^0.4.0"), true);
  assert.equal(satisfiesVersion("0.5.0", "^0.3.0 || ^0.4.0"), false);
  assert.equal(satisfiesVersion("3.1.0", "^1.0.0 || >=3.0.0 <4.0.0"), true);
});

test("prereleases only satisfy a range that declares a prerelease on the same tuple", () => {
  assert.equal(satisfiesVersion("0.1.5-rc.2", "^0.1.5"), false);
  assert.equal(satisfiesVersion("0.1.5-rc.3", "^0.1.5-rc.2"), true);
  assert.equal(satisfiesVersion("0.1.5-rc.1", "^0.1.5-rc.2"), false);
  assert.equal(satisfiesVersion("0.1.5", "^0.1.5-rc.2"), true);
  assert.equal(satisfiesVersion("0.1.6-alpha.2", ">=0.1.5-rc.2 <0.2.0"), false);
  assert.equal(satisfiesVersion("0.1.6", ">=0.1.5-rc.2 <0.2.0"), true);
  assert.equal(parseVersion("1.0.0-alpha+build")?.prerelease.join("."), "alpha");
});

test("tilde allows patch-level changes only", () => {
  assert.equal(satisfiesVersion("1.1.9", "~1.1.0"), true);
  assert.equal(satisfiesVersion("1.2.0", "~1.1.0"), false);
  assert.equal(satisfiesVersion("0.0.9", "~0.0.1"), true);
  assert.equal(satisfiesVersion("0.1.0", "~0.0.1"), false);
});

test("build metadata is ignored while numeric prerelease identifiers compare numerically", () => {
  assert.equal(satisfiesVersion("1.0.0+build.9", "1.0.0"), true);
  assert.equal(satisfiesVersion("1.0.0", "1.0.0+build.9"), true);
  assert.equal(satisfiesVersion("1.0.0-10", ">1.0.0-2"), true);
  assert.equal(satisfiesVersion("1.0.0-2", ">1.0.0-10"), false);
  assert.equal(satisfiesVersion("1.0.0-alpha.10", ">1.0.0-alpha.9"), true);
});

test("malformed versions and unsupported range syntax are rejected instead of silently passing", () => {
  assert.equal(isValidVersion("1.0"), false);
  assert.equal(isValidVersion("01.0.0"), false);
  assert.equal(isValidVersion("1.0.0-"), false);
  assert.equal(isValidVersion("1.0.0-alpha..1"), false);
  assert.equal(isValidRange("^1.0.0"), true);
  assert.equal(isValidRange(">=1.0.0 <2.0.0 || 3.0.0"), true);
  assert.equal(isValidRange("*"), false);
  assert.equal(isValidRange("1.x"), false);
  assert.equal(isValidRange("latest"), false);
  assert.equal(isValidRange("^1.0.0 ^"), false);
  assert.equal(isValidRange(""), false);
  assert.equal(satisfiesVersion("1.0.0", "garbage"), false);
  assert.equal(satisfiesVersion("garbage", "^1.0.0"), false);
});

test("normalizeRange expands shorthand into explicit comparator pairs", () => {
  assert.equal(normalizeRange("^0.3.0"), ">=0.3.0 <0.4.0");
  assert.equal(normalizeRange("~1.2.3"), ">=1.2.3 <1.3.0");
  assert.equal(normalizeRange("1.0.0"), "=1.0.0");
  assert.equal(normalizeRange("^1.0.0 || <2.0.0"), ">=1.0.0 <2.0.0 || <2.0.0");
});
