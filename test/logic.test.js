import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  branchLabel,
  cleanText,
  configuredCommand,
  copyShotAllowed,
  formatAheadBehind,
  formatDuration,
  formatWhen,
  manifestJson,
  mergeShot,
  openChoice,
  pathStaysUnder,
  parseAheadBehind,
  parseBranch,
  parseManifest,
  pickLatest,
  resolvedOpen,
  runLine,
  runRecord,
  safeRel,
  sameCommit,
  statusArgs,
  statusIsDirty,
  summarizeGit,
  trimLog,
  verdictFor,
  versionBelow,
} from "../mods/proof/logic.js";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const OTHER = "1234567890abcdef1234567890abcdef12345678";

function repo(over = {}) {
  return {
    kind: "repo",
    branch: "main",
    detached: false,
    sha: SHA,
    committedAt: "2026-11-10T03:00:00.000Z",
    ahead: 0,
    behind: 0,
    dirty: false,
    root: "/work",
    ...over,
  };
}

function evidence(over = {}) {
  return {
    ok: true,
    command: "npm test",
    at: "2026-11-10T03:05:00.000Z",
    duration_ms: 4200,
    commit: SHA,
    log: "last.log",
    shot: null,
    note: null,
    ...over,
  };
}

test("parseManifest reads a pass and drops unknown fields", () => {
  const { manifest, error } = parseManifest(JSON.stringify({
    ok: true,
    command: " npm test ",
    at: "2026-11-10T03:05:00.000Z",
    duration_ms: 4200,
    commit: SHA.toUpperCase(),
    log: "last.log",
    shot: "shots/window.png",
    note: "unit",
    extra: "ignored",
  }));
  assert.equal(error, null);
  assert.equal(manifest.ok, true);
  assert.equal(manifest.command, "npm test");
  assert.equal(manifest.commit, SHA);
  assert.equal(manifest.shot, "shots/window.png");
  assert.equal(manifest.extra, undefined);
});

test("parseManifest accepts an exit code", () => {
  assert.equal(parseManifest('{"ok":0,"commit":"abcdef0"}').manifest.ok, true);
  assert.equal(parseManifest('{"ok":1,"commit":"abcdef0"}').manifest.ok, false);
});

test("parseManifest rejects empty, broken, and non-objects", () => {
  assert.match(parseManifest("").error, /empty/);
  assert.match(parseManifest("{").error, /not JSON/);
  assert.match(parseManifest("[]").error, /object/);
  assert.match(parseManifest("null").error, /object/);
  assert.match(parseManifest("{}").error, /no evidence/);
});

test("parseManifest drops unsafe paths and junk fields without failing the run", () => {
  const { manifest, error } = parseManifest(JSON.stringify({
    ok: true,
    commit: "nope",
    log: "../secret",
    shot: "/etc/passwd",
    duration_ms: -5,
    at: "yesterday",
    command: "go test",
  }));
  assert.equal(error, null);
  assert.equal(manifest.ok, true);
  assert.equal(manifest.command, "go test");
  assert.equal(manifest.commit, null);
  assert.equal(manifest.log, null);
  assert.equal(manifest.shot, null);
  assert.equal(manifest.duration_ms, null);
  assert.equal(manifest.at, null);
});

test("safeRel keeps a nested relative path", () => {
  assert.equal(safeRel("shots/window.png"), "shots/window.png");
  assert.equal(safeRel(" ../x"), null);
  assert.equal(safeRel("shots//x.png"), null);
  assert.equal(safeRel("./shot.png"), null);
});

test("manifestJson round-trips", () => {
  const original = parseManifest('{"ok":false,"command":"cargo test","commit":"abc1234","log":"last.log"}').manifest;
  const again = parseManifest(manifestJson(original)).manifest;
  assert.deepEqual(again, original);
});

test("pickLatest chooses the newest run and ignores empties", () => {
  const older = evidence({ at: "2026-11-10T01:00:00.000Z", command: "old" });
  const newer = evidence({ at: "2026-11-10T02:00:00.000Z", command: "new" });
  assert.equal(pickLatest([older, newer]).command, "new");
  assert.equal(pickLatest([newer, older]).command, "new");
  assert.equal(pickLatest([null, evidence({ at: null, command: "bare" })]).command, "bare");
  assert.equal(pickLatest([]), null);
});

test("sameCommit matches full and short shas only", () => {
  assert.equal(sameCommit(SHA, SHA.slice(0, 7)), true);
  assert.equal(sameCommit(SHA.slice(0, 7), SHA), true);
  assert.equal(sameCommit(SHA, OTHER), false);
  assert.equal(sameCommit("abc", SHA), false);
  assert.equal(sameCommit(null, SHA), false);
});

const CMD = "npm test";

test("verdict is verified only when the configured command passed on this commit", () => {
  assert.equal(verdictFor(repo(), evidence(), CMD), "verified");
  assert.equal(verdictFor(repo(), evidence({ commit: SHA.slice(0, 7) }), CMD), "verified");
  assert.equal(verdictFor(repo({ detached: true, branch: null }), evidence(), CMD), "verified");
  assert.equal(verdictFor(repo(), evidence(), null), "unverified");
  assert.equal(verdictFor(repo(), evidence(), "make test"), "unverified");
});

test("a dirty tree is not verified, including untracked files", () => {
  assert.equal(verdictFor(repo({ dirty: true }), evidence(), CMD), "unverified");
  assert.equal(verdictFor(repo(), evidence({ dirty: true }), CMD), "unverified");
  const head = summarizeGit({
    root: "/wt",
    branchStdout: "refs/heads/main\n",
    branchCode: 0,
    countsStdout: "",
    countsCode: 128,
    shaStdout: `${SHA}\n`,
    shaCode: 0,
    whenStdout: "2026-11-10T03:00:00.000Z\n",
    whenCode: 0,
    dirtyStdout: "?? secret.env\n",
    dirtyCode: 0,
  });
  assert.equal(head.dirty, true);
  assert.equal(verdictFor(head, evidence(), CMD), "unverified");
});

test("a failed git status is dirty and is not recorded as clean", () => {
  assert.equal(statusIsDirty("", 128), true);
  assert.equal(statusIsDirty("", 1), true);
  assert.equal(statusIsDirty(undefined, undefined), true);
  assert.equal(statusIsDirty("", 0), false);
  assert.equal(statusIsDirty("?? x\n", 0), true);
  const head = summarizeGit({
    root: "/wt",
    branchStdout: "refs/heads/main\n",
    branchCode: 0,
    countsStdout: "",
    countsCode: 128,
    shaStdout: `${SHA}\n`,
    shaCode: 0,
    whenStdout: "2026-11-10T03:00:00.000Z\n",
    whenCode: 0,
    dirtyStdout: "",
    dirtyCode: 128,
    dirtyStderr: "fatal: not a valid object name",
  });
  assert.equal(head.dirty, true);
  assert.match(head.error, /git status failed|not a valid object name/);
  assert.equal(verdictFor(head, evidence(), CMD), "unverified");
  const recorded = runRecord({ command: CMD, exitCode: 0, startedMs: 0, finishedMs: 1, sha: SHA, dirty: head.dirty });
  assert.equal(recorded.dirty, true);
});

test("verdict is failing when that commit's run failed", () => {
  assert.equal(verdictFor(repo(), evidence({ ok: false }), CMD), "failing");
  assert.equal(verdictFor(repo({ dirty: true }), evidence({ ok: false }), CMD), "failing");
  assert.equal(verdictFor(repo(), evidence({ ok: false, commit: null }), CMD), "unverified");
});

test("verdict is stale when the evidence names another commit", () => {
  assert.equal(verdictFor(repo(), evidence({ commit: OTHER }), CMD), "stale");
  assert.equal(verdictFor(repo(), evidence({ ok: false, commit: OTHER }), CMD), "stale");
});

test("a matching commit stays verified even if the timestamp is earlier", () => {
  assert.equal(verdictFor(repo(), evidence({ at: "2026-11-09T00:00:00.000Z" }), CMD), "verified");
});

test("a missing commit is unverified inside a repository, even with a past or future time", () => {
  assert.equal(verdictFor(repo(), evidence({ commit: null, at: "2026-11-10T03:00:00.000Z" }), CMD), "unverified");
  const future = parseManifest(JSON.stringify({ ok: true, command: CMD, at: "2099-01-01T00:00:00.000Z" }), Date.parse("2026-11-10T03:10:00.000Z"));
  assert.equal(future.manifest.at, null);
  assert.equal(verdictFor(repo(), future.manifest, CMD), "unverified");
});

test("verdict is unverified without evidence, without a result, or when git cannot be read", () => {
  assert.equal(verdictFor(repo(), null), "unverified");
  assert.equal(verdictFor({ kind: "none" }, null), "unverified");
  assert.equal(verdictFor(repo(), evidence({ ok: null })), "unverified");
  assert.equal(verdictFor({ kind: "unsure" }, evidence()), "unverified");
  assert.equal(verdictFor(null, evidence({ ok: false })), "unverified");
});

test("no git cannot be verified, because there is no commit", () => {
  assert.equal(verdictFor({ kind: "none" }, evidence(), CMD), "unverified");
  assert.equal(verdictFor({ kind: "none" }, evidence({ ok: false }), CMD), "failing");
  assert.equal(verdictFor({ kind: "none" }, evidence({ commit: OTHER, ok: true }), CMD), "unverified");
});

test("parseBranch and ahead/behind", () => {
  assert.deepEqual(parseBranch("refs/heads/fix/login\n", 0), { branch: "fix/login", detached: false });
  assert.deepEqual(parseBranch("", 1), { branch: null, detached: true });
  assert.deepEqual(parseAheadBehind("2\t1\n", 0), { ahead: 2, behind: 1 });
  assert.deepEqual(parseAheadBehind("", 128), { ahead: null, behind: null });
  assert.deepEqual(parseAheadBehind("nope", 0), { ahead: null, behind: null });
});

test("summarizeGit builds a detached dirty repo and a non-repo", () => {
  const head = summarizeGit({
    root: "/wt",
    branchStdout: "",
    branchCode: 1,
    countsStdout: "",
    countsCode: 128,
    shaStdout: `${SHA}\n`,
    shaCode: 0,
    whenStdout: "2026-11-10T03:00:00.000Z\n",
    whenCode: 0,
    dirtyStdout: " M README\n",
    dirtyCode: 0,
  });
  assert.equal(head.kind, "repo");
  assert.equal(head.detached, true);
  assert.equal(head.sha, SHA);
  assert.equal(head.dirty, true);
  assert.equal(head.ahead, null);
  assert.equal(branchLabel(head), `detached ${SHA.slice(0, 7)}`);
  assert.equal(summarizeGit({ root: null }).kind, "none");
  assert.equal(branchLabel(summarizeGit({ root: null })), "No git");
});

test("formatters stay short", () => {
  assert.equal(formatAheadBehind(2, 0), "↑2");
  assert.equal(formatAheadBehind(0, 3), "↓3");
  assert.equal(formatAheadBehind(null, null), "");
  assert.equal(formatAheadBehind(0, 0), "");
  assert.equal(formatDuration(800), "800ms");
  assert.equal(formatDuration(4200), "4.2s");
  assert.equal(formatDuration(12500), "13s");
  assert.equal(formatDuration(65000), "1m 5s");
  const now = Date.parse("2026-11-10T03:10:00.000Z");
  assert.equal(formatWhen("2026-11-10T03:09:50.000Z", now), "10s ago");
  assert.equal(formatWhen("2026-11-10T03:09:59.000Z", now), "just now");
  assert.equal(formatWhen("2026-11-10T01:10:00.000Z", now), "2h ago");
  assert.equal(runLine(evidence(), now), "npm test · pass · 5m ago · 4.2s");
  assert.equal(runLine(null, now), "No evidence");
});

test("configured command comes from the user, never a repo file", () => {
  const picked = configuredCommand(" npm test ", "make test");
  assert.equal(picked.command, "npm test");
  assert.equal(picked.timeout_ms, 120000);
  assert.equal(configuredCommand(null, "make test").command, "make test");
  assert.equal(configuredCommand("", null).command, null);
  assert.equal(configuredCommand("x", null, { propTimeout: 500 }).timeout_ms, 1000);
  assert.equal(configuredCommand("x".repeat(241), "npm test").command, "npm test");
});

test("runRecord and mergeShot write the files an agent would", () => {
  const record = runRecord({
    command: "npm test",
    exitCode: 1,
    startedMs: 1_000,
    finishedMs: 2_500,
    sha: SHA,
    note: "timed out",
  });
  assert.equal(record.ok, false);
  assert.equal(record.duration_ms, 1500);
  assert.equal(record.commit, SHA);
  assert.equal(record.log, "last.log");
  assert.equal(record.v, 1);
  assert.equal(record.dirty, false);
  const dirtyRun = runRecord({ command: "npm test", exitCode: 0, startedMs: 0, finishedMs: 10, sha: SHA, dirty: true });
  assert.equal(dirtyRun.dirty, true);
  assert.equal(verdictFor(repo(), dirtyRun, CMD), "unverified");
  const merged = mergeShot(record, "shots/a.png");
  assert.equal(merged.ok, false);
  assert.equal(merged.shot, "shots/a.png");
  assert.equal(merged.at, record.at);
  const fresh = mergeShot(null, "shots/a.png", { sha: SHA, at: "2026-11-10T03:05:00.000Z" });
  assert.equal(fresh.ok, null);
  assert.equal(fresh.commit, SHA);
  assert.equal(mergeShot(null, "../x"), null);
});

test("a hostile repository cannot pick Run, open a script, or earn Verified", () => {
  const root = new URL("./fixtures/malicious-repo/dot-proof/", import.meta.url);
  const config = JSON.parse(readFileSync(new URL("config.json", root), "utf8"));
  const raw = readFileSync(new URL("latest.json", root), "utf8");
  const now = Date.parse("2026-11-10T03:10:00.000Z");
  const { manifest, error } = parseManifest(raw, now);
  assert.equal(error, null);
  assert.equal(manifest.at, null);
  assert.equal(manifest.commit, null);
  assert.equal(manifest.note, "pass");
  assert.equal(cleanText("ok\u202e\u0007hidden", 40), "okhidden");
  const command = configuredCommand("npm test", null);
  assert.equal(command.command, "npm test");
  assert.notEqual(command.command, config.command);
  assert.equal(verdictFor(repo(), manifest, command.command), "unverified");
  assert.deepEqual(openChoice("/work/evil", manifest), { path: "/work/evil/.proof", kind: "dir" });
  assert.deepEqual(openChoice("/work/evil", { ...manifest, shot: null, log: "last.log" }), { path: "/work/evil/.proof/last.log", kind: "file" });
  assert.deepEqual(openChoice("/work/evil", { shot: "shots/window.png" }), { path: "/work/evil/.proof/shots/window.png", kind: "file" });
  assert.equal(copyShotAllowed("shots/evil.sh"), false);
  assert.equal(copyShotAllowed("shots/pass.png", { symlink: true }), false);
  assert.equal(copyShotAllowed("shots/pass.png"), true);
  assert.equal(pathStaysUnder("/work/.proof", "/work/.proof/shots/a.png"), true);
  assert.equal(pathStaysUnder("/work/.proof", "/work/.proof-evil/a.png"), false);
  assert.equal(pathStaysUnder("/work/.proof", "/etc/passwd"), false);
  const repoRoot = "/work/repo";
  const shot = { shot: "shots/x.png" };
  assert.equal(resolvedOpen(repoRoot, shot, { isFile: false, realFile: `${repoRoot}/.proof/shots/x.png`, realDir: `${repoRoot}/.proof` }).kind, "dir");
  assert.equal(resolvedOpen(repoRoot, shot, { isFile: true, realFile: "/tmp/elsewhere/x.png", realDir: `${repoRoot}/.proof` }).kind, "dir");
  assert.equal(resolvedOpen(repoRoot, shot, { isFile: true, realFile: `${repoRoot}/.proof/shots/x.png`, realDir: `${repoRoot}/.proof` }).path, `${repoRoot}/.proof/shots/x.png`);
  assert.deepEqual(statusArgs(), ["status", "--porcelain=v1", "--", ".", ":!.proof"]);
  assert.equal(parseManifest("x".repeat(64 * 1024 + 1)).error, "Manifest is too large");
  assert.equal(parseManifest('{"v":2,"ok":true,"commit":"abcdef0"}').error, "Unsupported proof version");
  assert.equal(parseManifest('{"ok":true,"commit":"abcdef0"}').manifest.v, 1);
  assert.equal(versionBelow("0.1.13"), true);
  assert.equal(versionBelow("0.1.14"), false);
  assert.equal(versionBelow("0.2.0"), false);
});

test("trimLog keeps the tail", () => {
  assert.equal(trimLog("a", "b", 10), "a\nb");
  assert.equal(trimLog("hello world", "", 7), "…\nworld");
});
