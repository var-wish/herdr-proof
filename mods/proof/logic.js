// Pure rules for Proof. No Herdr, no filesystem: main.js does the reading.
// A repository's files never choose what Run executes, and they cannot mint
// a Verified badge without a matching commit on a clean tree.

const EVIDENCE_FIELDS = ["ok", "command", "at", "duration_ms", "commit", "log", "shot", "note"];
const MAX_DURATION = 7 * 24 * 60 * 60 * 1000;
const MAX_TEXT = 64 * 1024;
const SKEW_MS = 2 * 60 * 1000;
const OPEN_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "log", "txt"]);
export const SCHEMA = 1;
export const MIN_HERDR = "0.1.14";

export function blankManifest() {
  return {
    v: null,
    ok: null,
    command: null,
    at: null,
    duration_ms: null,
    commit: null,
    log: null,
    shot: null,
    note: null,
    dirty: null,
  };
}

export function hasEvidence(manifest) {
  return Boolean(manifest) && EVIDENCE_FIELDS.some((key) => manifest[key] != null);
}

export function normalizeCommit(value) {
  if (typeof value !== "string") return null;
  const sha = value.trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
}

// Either string is a prefix of the other, so a 7-char sha matches the full one.
export function sameCommit(a, b) {
  const left = normalizeCommit(a);
  const right = normalizeCommit(b);
  if (!left || !right) return false;
  return left.startsWith(right) || right.startsWith(left);
}

export function safeRel(input) {
  if (typeof input !== "string") return null;
  const text = stripControls(input).trim();
  if (!text || text.startsWith("/") || text.includes("\\") || text.includes("\0")) return null;
  const parts = text.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

export function isImage(rel) {
  return extension(rel) != null && OPEN_EXT.has(extension(rel)) && /^(png|jpe?g|gif|webp)$/.test(extension(rel));
}

function extension(rel) {
  if (typeof rel !== "string" || !rel.includes(".")) return null;
  return rel.split(".").pop().toLowerCase();
}

export function resolveUnder(root, rel) {
  const safe = safeRel(rel);
  if (!safe || typeof root !== "string" || !root) return null;
  return `${root.replace(/\/+$/, "")}/.proof/${safe}`;
}

// Drop C0/C1 controls and bidi/zero-width marks so a label cannot hide the
// rest of a command or spoof "Verified".
function stripControls(value) {
  return value.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
}

export function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const text = stripControls(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

// A command we will execute is never silently chopped.
function commandText(value) {
  if (typeof value !== "string") return null;
  const text = stripControls(value).trim();
  if (!text || text.length > 240) return null;
  return text;
}

function parseOk(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isInteger(value)) return value === 0;
  return null;
}

// `at` later than now, plus a small skew, is ignored. A future clock cannot
// stand in for a commit.
export function parseWhen(value, nowMs = Date.now()) {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  if (at > nowMs + SKEW_MS) return null;
  return value.trim();
}

function parseDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_DURATION) return null;
  return Math.round(value);
}

function parseDirty(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

// A manifest is one run. Unknown fields are ignored. A bad field is dropped,
// not fatal, so one stray key does not hide a good pass/fail.
export function parseManifest(text, nowMs = Date.now()) {
  if (typeof text !== "string" || !text.trim()) return { manifest: null, error: "Manifest is empty" };
  if (text.length > MAX_TEXT) return { manifest: null, error: "Manifest is too large" };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { manifest: null, error: "Manifest is not JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { manifest: null, error: "Manifest must be a JSON object" };
  }
  if (value.v != null && value.v !== SCHEMA) return { manifest: null, error: "Unsupported proof version" };
  const manifest = {
    ...blankManifest(),
    v: SCHEMA,
    ok: parseOk(value.ok),
    command: cleanText(value.command, 240),
    at: parseWhen(value.at, nowMs),
    duration_ms: parseDuration(value.duration_ms),
    commit: normalizeCommit(value.commit),
    log: safeRel(value.log),
    shot: safeRel(value.shot),
    note: cleanText(value.note, 160),
    dirty: parseDirty(value.dirty),
  };
  if (!hasEvidence(manifest)) return { manifest: null, error: "Manifest has no evidence" };
  return { manifest, error: null };
}

export function manifestJson(manifest) {
  const out = { v: SCHEMA };
  for (const key of [...EVIDENCE_FIELDS, "dirty"]) {
    if (manifest?.[key] != null) out[key] = manifest[key];
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

// latest.json wins when the caller has one. This picks among run files.
export function pickLatest(manifests) {
  let best = null;
  let bestAt = -Infinity;
  for (const manifest of manifests ?? []) {
    if (!hasEvidence(manifest)) continue;
    const at = manifest.at ? Date.parse(manifest.at) : NaN;
    const score = Number.isNaN(at) ? -Infinity : at;
    if (!best || score >= bestAt) {
      best = manifest;
      bestAt = score;
    }
  }
  return best;
}

function clampTimeout(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(600000, Math.max(1000, Math.round(value)));
}

// The worktree does not get a say. Props win, then the shared setting.
export function configuredCommand(propCommand, sharedCommand, options = {}) {
  const command = commandText(propCommand) || commandText(sharedCommand) || null;
  const timeout_ms = clampTimeout(options.propTimeout) ?? clampTimeout(options.sharedTimeout) ?? 120000;
  return { command, timeout_ms };
}

// Open only pictures and plain logs. Anything else, including a script the
// repo named, opens the .proof directory instead.
export function openChoice(root, evidence) {
  const dir = `${String(root || "").replace(/\/+$/, "")}/.proof`;
  const rel = safeRel(evidence?.shot) || safeRel(evidence?.log);
  const ext = rel ? extension(rel) : null;
  if (!rel || !ext || !OPEN_EXT.has(ext)) return { path: dir, kind: "dir" };
  return { path: `${dir}/${rel}`, kind: "file" };
}

export function copyShotAllowed(rel, { symlink = false } = {}) {
  return Boolean(isImage(rel)) && symlink !== true;
}

export function parseBranch(stdout, code) {
  if (code !== 0) return { branch: null, detached: true };
  const ref = String(stdout ?? "").trim();
  if (!ref) return { branch: null, detached: true };
  return { branch: ref.replace(/^refs\/heads\//, ""), detached: false };
}

export function parseAheadBehind(stdout, code) {
  if (code !== 0) return { ahead: null, behind: null };
  const parts = String(stdout ?? "").trim().split(/\s+/).map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) return { ahead: null, behind: null };
  return { ahead: parts[0], behind: parts[1] };
}

export function summarizeGit({ root, branchStdout, branchCode, countsStdout, countsCode, shaStdout, shaCode, whenStdout, whenCode, dirtyStdout, dirtyCode }) {
  if (!root) {
    return { kind: "none", branch: null, detached: false, sha: null, committedAt: null, ahead: null, behind: null, dirty: false, root: null };
  }
  const branch = parseBranch(branchStdout, branchCode);
  const counts = parseAheadBehind(countsStdout, countsCode);
  const when = whenCode === 0 ? parseWhen(String(whenStdout ?? "").trim(), Date.now() + SKEW_MS) : null;
  return {
    kind: "repo",
    branch: branch.branch,
    detached: branch.detached,
    sha: shaCode === 0 ? normalizeCommit(String(shaStdout ?? "").trim()) : null,
    committedAt: when,
    ahead: counts.ahead,
    behind: counts.behind,
    dirty: dirtyCode === 0 && String(dirtyStdout ?? "").trim().length > 0,
    root,
  };
}

function commitTied(head, evidence) {
  return Boolean(evidence.commit && head.sha && sameCommit(evidence.commit, head.sha));
}

function sameCommand(evidence, command) {
  const wanted = commandText(command);
  return Boolean(wanted && evidence.command && evidence.command === wanted);
}

// Verified means the configured command passed on this exact commit and the
// tree was clean. It does not mean the change is correct.
export function verdictFor(head, evidence, command = null) {
  if (!hasEvidence(evidence)) return "unverified";
  if (!head || head.kind === "unsure" || head.kind === "none") {
    if (head?.kind === "none" && evidence.ok === false) return "failing";
    return "unverified";
  }
  if (!evidence.commit || !commitTied(head, evidence)) {
    return evidence.commit ? "stale" : "unverified";
  }
  if (evidence.ok === false) return "failing";
  if (evidence.ok !== true) return "unverified";
  if (head.dirty || evidence.dirty === true) return "unverified";
  if (!sameCommand(evidence, command)) return "unverified";
  return "verified";
}

export function versionBelow(version, min = MIN_HERDR) {
  const parse = (value) => String(value ?? "").split(".").map((part) => {
    const match = /^(\d+)/.exec(part);
    return match ? Number(match[1]) : 0;
  });
  const left = parse(version);
  const right = parse(min);
  for (let i = 0; i < 3; i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a < b) return true;
    if (a > b) return false;
  }
  return false;
}

export function branchLabel(head) {
  if (!head || head.kind === "loading") return "…";
  if (head.kind === "none") return "No git";
  if (head.kind === "unsure") return "Git unavailable";
  if (!head.sha && !head.branch) return "No commits";
  if (head.detached || !head.branch) return head.sha ? `detached ${head.sha.slice(0, 7)}` : "detached";
  return head.branch;
}

export function formatAheadBehind(ahead, behind) {
  const parts = [];
  if (typeof ahead === "number" && ahead > 0) parts.push(`↑${ahead}`);
  if (typeof behind === "number" && behind > 0) parts.push(`↓${behind}`);
  return parts.join(" ");
}

export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) {
    const seconds = ms / 1000;
    return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  }
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${seconds}s`;
}

export function formatWhen(iso, nowMs) {
  const at = Date.parse(iso ?? "");
  if (Number.isNaN(at)) return "";
  const delta = nowMs - at;
  if (Math.abs(delta) < 5000) return "just now";
  if (delta < 0) return iso.slice(0, 10);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return iso.slice(0, 10);
}

export function runLine(manifest, nowMs) {
  if (!hasEvidence(manifest)) return "No evidence";
  const parts = [];
  if (manifest.command) parts.push(manifest.command);
  if (manifest.ok === true) parts.push("pass");
  else if (manifest.ok === false) parts.push("fail");
  if (manifest.dirty === true) parts.push("dirty");
  const when = formatWhen(manifest.at, nowMs);
  if (when) parts.push(when);
  const duration = formatDuration(manifest.duration_ms);
  if (duration) parts.push(duration);
  return parts.join(" · ") || "Evidence";
}

export function runRecord({ command, exitCode, startedMs, finishedMs, sha, note, dirty }) {
  const duration = Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : null;
  return {
    ...blankManifest(),
    v: SCHEMA,
    ok: exitCode === 0,
    command: commandText(command),
    at: Number.isFinite(finishedMs) ? new Date(finishedMs).toISOString() : null,
    duration_ms: duration,
    commit: normalizeCommit(sha),
    log: "last.log",
    note: cleanText(note, 160),
    dirty: dirty === true,
  };
}

export function mergeShot(manifest, shot, { sha, at } = {}) {
  const safe = safeRel(shot);
  if (!safe) return manifest ?? null;
  if (hasEvidence(manifest)) return { ...manifest, v: SCHEMA, shot: safe };
  return { ...blankManifest(), v: SCHEMA, shot: safe, at: parseWhen(at), commit: normalizeCommit(sha) };
}

export function trimLog(stdout, stderr, limit = 32000) {
  const text = [stdout, stderr].filter((part) => typeof part === "string" && part).join("\n");
  if (text.length <= limit) return text;
  const tail = text.slice(text.length - (limit - 2));
  return `…\n${tail}`;
}

export const VERDICTS = {
  verified: "Verified",
  unverified: "Unverified",
  stale: "Stale",
  failing: "Failing",
};
