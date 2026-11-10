import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathStaysUnder, statusArgs, statusIsDirty } from "../mods/proof/logic.js";

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

test("untracked .proof does not make the worktree dirty", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-status-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "dev@example.com"]);
  git(dir, ["config", "user.name", "Proof tests"]);
  writeFileSync(join(dir, "README"), "a\n");
  git(dir, ["add", "README"]);
  git(dir, ["commit", "-qm", "init"]);
  mkdirSync(join(dir, ".proof"));
  writeFileSync(join(dir, ".proof", "latest.json"), "{}\n");
  const only = git(dir, statusArgs());
  assert.equal(only, "");
  assert.equal(statusIsDirty(only, 0), false);
  writeFileSync(join(dir, "OTHER.txt"), "x\n");
  const more = git(dir, statusArgs());
  assert.match(more, /OTHER\.txt/);
  assert.doesNotMatch(more, /\.proof/);
  assert.equal(statusIsDirty(more, 0), true);
});

test("a symlinked parent or a directory named like an image stays closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-open-"));
  const outside = mkdtempSync(join(tmpdir(), "proof-outside-"));
  const proof = join(dir, ".proof");
  mkdirSync(proof);
  writeFileSync(join(outside, "x.png"), "not an image");
  symlinkSync(outside, join(proof, "shots"));
  mkdirSync(join(proof, "x.png"));
  const realDir = execFileSync("realpath", ["-e", proof], { encoding: "utf8" }).trim();
  const escaped = execFileSync("realpath", ["-e", join(proof, "shots", "x.png")], { encoding: "utf8" }).trim();
  assert.equal(pathStaysUnder(realDir, escaped), false);
  const directory = spawnSync("test", ["-f", join(proof, "x.png")]);
  assert.notEqual(directory.status, 0);
  const inside = join(proof, "notes.txt");
  writeFileSync(inside, "log\n");
  const realFile = execFileSync("realpath", ["-e", inside], { encoding: "utf8" }).trim();
  assert.equal(pathStaysUnder(realDir, realFile), true);
});
