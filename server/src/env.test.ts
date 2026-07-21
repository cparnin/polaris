import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./env.js";

test("loads KEY=VALUE pairs, skipping comments and blanks", () => {
  const dir = mkdtempSync(join(tmpdir(), "polaris-env-"));
  const file = join(dir, ".env");
  try {
    writeFileSync(
      file,
      ["# a comment", "", "NTFY_URL=https://ntfy.sh/topic-abc", 'ISP_NAME="Frontier"', "BARE=  spaced  "].join("\n")
    );
    process.env.POLARIS_ENV_FILE = file;
    delete process.env.NTFY_URL;
    delete process.env.ISP_NAME;
    delete process.env.BARE;

    loadEnv();

    assert.equal(process.env.NTFY_URL, "https://ntfy.sh/topic-abc");
    assert.equal(process.env.ISP_NAME, "Frontier", "surrounding quotes are stripped");
    assert.equal(process.env.BARE, "spaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.POLARIS_ENV_FILE;
    delete process.env.NTFY_URL;
    delete process.env.ISP_NAME;
    delete process.env.BARE;
  }
});

test("a real environment variable wins over the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "polaris-env-"));
  const file = join(dir, ".env");
  try {
    writeFileSync(file, "NTFY_URL=from-file");
    process.env.POLARIS_ENV_FILE = file;
    process.env.NTFY_URL = "from-shell";

    loadEnv();

    assert.equal(process.env.NTFY_URL, "from-shell");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.POLARIS_ENV_FILE;
    delete process.env.NTFY_URL;
  }
});

test("a missing .env is not fatal", () => {
  process.env.POLARIS_ENV_FILE = join(tmpdir(), "definitely-not-here-polaris", ".env");
  assert.doesNotThrow(() => loadEnv());
  delete process.env.POLARIS_ENV_FILE;
});

test("strips trailing inline comments from unquoted values", () => {
  // Without this, NTFY_URL keeps the comment, new URL() still parses a valid
  // .host, ntfyStatus() reports "configured", and every notification 404s to
  // the console - the exact silent failure .env loading was added to end.
  const dir = mkdtempSync(join(tmpdir(), "polaris-env-"));
  const file = join(dir, ".env");
  try {
    writeFileSync(
      file,
      [
        "NTFY_URL=https://ntfy.sh/topic-abc   # my topic",
        "EVENT_RETENTION=5000 # keep 5k",
        "HASH_VALUE=abc#notacomment",
        'QUOTED="keep # this"',
      ].join("\n")
    );
    process.env.POLARIS_ENV_FILE = file;
    for (const k of ["NTFY_URL", "EVENT_RETENTION", "HASH_VALUE", "QUOTED"]) delete process.env[k];

    loadEnv();

    assert.equal(process.env.NTFY_URL, "https://ntfy.sh/topic-abc");
    assert.equal(process.env.EVENT_RETENTION, "5000");
    assert.equal(process.env.HASH_VALUE, "abc#notacomment", "no whitespace: part of the value");
    assert.equal(process.env.QUOTED, "keep # this", "quoted values are taken verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.POLARIS_ENV_FILE;
    for (const k of ["NTFY_URL", "EVENT_RETENTION", "HASH_VALUE", "QUOTED"]) delete process.env[k];
  }
});

test("accepts an `export KEY=value` prefix", () => {
  // .env files are commonly also sourced from a shell, so `export` shows up.
  const dir = mkdtempSync(join(tmpdir(), "polaris-env-"));
  const file = join(dir, ".env");
  try {
    writeFileSync(file, "export ISP_NAME=Frontier\n");
    process.env.POLARIS_ENV_FILE = file;
    delete process.env.ISP_NAME;

    loadEnv();

    assert.equal(process.env.ISP_NAME, "Frontier");
    assert.equal(process.env["export ISP_NAME"], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.POLARIS_ENV_FILE;
    delete process.env.ISP_NAME;
  }
});
