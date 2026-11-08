// @ts-check
// Unit tests of src/lib/json.js: the parse that never throws, the query strip, the host, the deep
// strip of every URL's query inside a JSON value.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hostOf,
  isRecord,
  safeParse,
  stripQuery,
  stripUrlQueries,
  stripUrlQueriesInText,
} from "../src/lib/json.js";

test("safeParse never throws: JSON comes back, anything else is undefined", () => {
  assert.deepEqual(safeParse('{"a": [1, "b", null]}'), { a: [1, "b", null] });
  assert.equal(safeParse("42"), 42);
  assert.equal(safeParse("null"), null);
  assert.equal(safeParse(""), undefined);
  assert.equal(safeParse("{broken"), undefined);
  assert.equal(safeParse("<html>"), undefined);
  assert.equal(safeParse(undefined), undefined);
  assert.equal(safeParse(12), undefined);
});

test("isRecord tells a plain object from arrays, null and scalars", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("x"), false);
  assert.equal(isRecord(undefined), false);
});

test("stripQuery cuts at the first ? or #, on URLs and on any string", () => {
  assert.equal(
    stripQuery("https://upos-sz-mirror.bilivideo.com/upgcxcode/1.m4s?deadline=1&gen=playurlv3"),
    "https://upos-sz-mirror.bilivideo.com/upgcxcode/1.m4s",
  );
  assert.equal(
    stripQuery("https://www.dailymotion.com/video/x8vu47w#comments"),
    "https://www.dailymotion.com/video/x8vu47w",
  );
  assert.equal(stripQuery("https://host/path?a=1#frag"), "https://host/path");
  assert.equal(stripQuery("https://host/path"), "https://host/path");
  assert.equal(stripQuery("junk?x"), "junk");
  assert.equal(stripQuery(""), "");
});

test("hostOf: the lowercase host of an http(s) URL, without the port; null otherwise", () => {
  assert.equal(hostOf("https://WWW.Bilibili.com/video/BV1GJ411x7h7"), "www.bilibili.com");
  assert.equal(hostOf("http://127.0.0.1:8123/bili/cdn/1.m4s?x=1"), "127.0.0.1");
  assert.equal(hostOf("ftp://example.com/x"), null);
  assert.equal(hostOf("/relative/path"), null);
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf(""), null);
});

test("stripUrlQueries: a deep copy with every URL's query gone, nothing else touched", () => {
  const raw = {
    title: "Why? Because #1",
    url: "https://s1.dmcdn.net/v/abc/x720.jpg?sec=signed",
    nested: { list: ["//s2.dmcdn.net/p.jpg?x=1", "plain", 3, null, true], deadline: 1700000000 },
    text: "HTTP 403 on https://u.bilivideo.com/a.m4s?deadline=1&p=pc then 'https://h/p?q'",
  };
  const copy = stripUrlQueries(raw);
  assert.deepEqual(copy, {
    title: "Why? Because #1",
    url: "https://s1.dmcdn.net/v/abc/x720.jpg",
    nested: { list: ["//s2.dmcdn.net/p.jpg", "plain", 3, null, true], deadline: 1700000000 },
    text: "HTTP 403 on https://u.bilivideo.com/a.m4s then 'https://h/p'",
  });
  assert.notEqual(copy, raw);
  assert.notEqual(copy.nested, raw.nested);
  // the original is untouched
  assert.equal(raw.url, "https://s1.dmcdn.net/v/abc/x720.jpg?sec=signed");
  assert.equal(stripUrlQueries(7), 7);
  assert.equal(stripUrlQueries(null), null);
  assert.equal(stripUrlQueries("https://h/p?q#f"), "https://h/p");
  assert.equal(stripUrlQueriesInText("no url here? really #yes"), "no url here? really #yes");
  assert.equal(
    stripUrlQueriesInText('"https://h/p?q" and <https://h/r#x>'),
    '"https://h/p" and <https://h/r>',
  );
});
