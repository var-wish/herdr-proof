// Proof: one row per space, with the branch and whether its latest check
// still applies. Evidence lives in <worktree>/.proof (see the repo README).
// Git is read, never written. Run and Shot are the only writers, and only
// under .proof. The panel is a Herdr list (mark + label), not status bars.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, appHome, exec, panes, props, readTextFile, run, shared, spaces, theme, watchFolder, window, writeTextFile } from "herdr";
import {
  MIN_HERDR,
  VERDICTS,
  branchLabel,
  configuredCommand,
  copyShotAllowed,
  formatAheadBehind,
  formatWhen,
  hasEvidence,
  isImage,
  manifestJson,
  mergeShot,
  openChoice,
  parseManifest,
  pickLatest,
  resolveUnder,
  resolvedOpen,
  runLine,
  runRecord,
  statusArgs,
  summarizeGit,
  trimLog,
  verdictFor,
  versionBelow,
} from "./logic.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const POLL_MS = 10000;

function place(space, paneList) {
  const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
  return paneList.find((pane) => tabs.has(pane.tab) && pane.cwd)?.cwd || space.folder || null;
}

function signature() {
  const paneList = panes();
  return spaces().map((space) => `${space.id}\t${space.machine ?? ""}\t${place(space, paneList) ?? ""}`).join("\n");
}

function git(cwd, on, args) {
  return exec("git", [...READ, ...args], { cwd, on, timeout: 8000 });
}

async function readGit(cwd, on) {
  const top = await git(cwd, on, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (top.code !== 0) {
    if (/not a git repository/i.test(`${top.stderr}\n${top.stdout}`)) return summarizeGit({ root: null });
    return { kind: "unsure", error: (top.stderr || top.stdout || "git failed").trim().slice(0, 160) };
  }
  const root = top.stdout.replace(/\n$/, "");
  const [branch, counts, sha, when, dirty] = await Promise.all([
    git(root, on, ["symbolic-ref", "-q", "HEAD"]),
    git(root, on, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
    git(root, on, ["rev-parse", "--verify", "HEAD"]),
    git(root, on, ["log", "-1", "--format=%cI"]),
    git(root, on, statusArgs()),
  ]);
  return summarizeGit({
    root,
    branchStdout: branch.stdout,
    branchCode: branch.code,
    countsStdout: counts.stdout,
    countsCode: counts.code,
    shaStdout: sha.stdout,
    shaCode: sha.code,
    whenStdout: when.stdout,
    whenCode: when.code,
    dirtyStdout: dirty.stdout,
    dirtyCode: dirty.code,
    dirtyStderr: dirty.stderr,
  });
}

const MAX_TEXT = 64 * 1024;

// readTextFile already stops at 1 MiB. Refuse anything past our own cap
// before it can be parsed into a badge.
function bounded(text) {
  if (text == null) return null;
  if (text.length > MAX_TEXT) return null;
  return text;
}

async function readProof(root, on) {
  const dir = `${root}/.proof`;
  const latestFull = await readTextFile(`${dir}/latest.json`, { on });
  if (latestFull != null) {
    const latestRaw = bounded(latestFull);
    if (latestRaw == null) return { dir, evidence: null, error: "Manifest is too large" };
    const parsed = parseManifest(latestRaw);
    if (parsed.manifest) return { dir, evidence: parsed.manifest, error: null };
    return { dir, evidence: null, error: parsed.error };
  }
  let listing;
  try {
    listing = await exec("sh", ["-c", "ls -1 .proof/runs/*.json 2>/dev/null"], { cwd: root, on, timeout: 8000 });
  } catch {
    listing = { code: 1, stdout: "" };
  }
  if (!listing.stdout?.trim()) return { dir, evidence: null, error: null };
  const manifests = [];
  for (const name of listing.stdout.trim().split("\n").slice(-32)) {
    const rel = name.trim().replace(/^\.\//, "");
    if (!rel) continue;
    const text = bounded(await readTextFile(`${root}/${rel}`, { on }));
    if (text == null) continue;
    const parsed = parseManifest(text);
    if (parsed.manifest) manifests.push(parsed.manifest);
  }
  return { dir, evidence: pickLatest(manifests), error: null };
}

async function putFile(path, text, on) {
  if (on) {
    const result = await exec("python3", ["-c", "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True, exist_ok=True); p.write_text(sys.argv[2])", path, text], { on, timeout: 8000 });
    if (result.code !== 0) throw new Error((result.stderr || "could not write").trim());
    return;
  }
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prev = await readTextFile(path);
    try {
      await writeTextFile(path, text, prev);
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

function shell(command, cwd, on, timeout) {
  if (window().platform === "windows") return exec("cmd", ["/d", "/c", command], { cwd, on, timeout });
  return exec("sh", ["-c", command], { cwd, on, timeout });
}

async function shotFile(dest) {
  try {
    return await exec("herdr-app", ["shot", dest], { timeout: 20000 });
  } catch {
    return exec(`${homeBin()}/herdr-app`, ["shot", dest], { timeout: 20000 });
  }
}

function homeBin() {
  return `${appHome().replace(/\/\.config\/herdr-app\/?$/, "")}/.local/bin`;
}

function openPath(path, on) {
  const platform = window().platform;
  if (platform === "macos") return exec("open", [path], { on, timeout: 8000 });
  if (platform === "windows") return exec("cmd", ["/d", "/c", "start", "", path], { on, timeout: 8000 });
  return exec("xdg-open", [path], { on, timeout: 8000 });
}

function tone(t, verdict) {
  if (verdict === "verified") return t.done;
  if (verdict === "failing") return t.blocked;
  if (verdict === "stale") return t.working;
  return t.dim;
}

function agentLine(spaceId) {
  const list = agents().filter((agent) => agent.space === spaceId);
  if (!list.length) return "";
  const rank = { blocked: 0, done: 1, working: 2, idle: 3 };
  const top = [...list].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))[0];
  const name = top.program?.name || top.app || "agent";
  const extra = list.length > 1 ? ` +${list.length - 1}` : "";
  return `${name} · ${top.status}${extra}`;
}

function headerSummary(counts) {
  const urgent = [];
  if (counts.failing) urgent.push(`${counts.failing} failing`);
  if (counts.stale) urgent.push(`${counts.stale} stale`);
  if (counts.unverified) urgent.push(`${counts.unverified} unverified`);
  if (urgent.length) return urgent.join(" · ");
  if (counts.verified) return "All verified";
  return "";
}

function footerCounts(spaceCount, counts) {
  if (!spaceCount) return "";
  const parts = [`${spaceCount} space${spaceCount === 1 ? "" : "s"}`];
  if (counts.failing) parts.push(`${counts.failing} failing`);
  else if (counts.stale) parts.push(`${counts.stale} stale`);
  else if (counts.unverified) parts.push(`${counts.unverified} unverified`);
  return parts.join(" · ");
}

function metaBits(card, head, now) {
  const bits = [];
  if (!card) return ["…"];
  if (!card.cwd) bits.push("No folder");
  else bits.push(branchLabel(head));
  const ahead = head?.kind === "repo" ? formatAheadBehind(head.ahead, head.behind) : "";
  if (ahead) bits.push(ahead);
  const when = hasEvidence(card.evidence) ? formatWhen(card.evidence.at, now) : "";
  if (when) bits.push(when);
  else if (!hasEvidence(card.evidence) && card.cwd) bits.push("No evidence");
  return bits;
}

// Missing updates() is an old build, not a reason to blank the panel.
async function probeVersion() {
  try {
    const herdr = await import("herdr");
    if (typeof herdr.updates !== "function") return { missing: true };
    const version = herdr.updates()?.app?.version;
    if (typeof version !== "string" || !version) return { missing: true };
    return { missing: false, version };
  } catch {
    return { missing: true };
  }
}

export default class Proof extends View {
  init(_props, cx) {
    this.cards = {};
    this.busy = {};
    this.notes = {};
    this.copied = {};
    this.watching = new Set();
    this.unwatchable = new Set();
    this.loading = false;
    this.again = false;
    this.gen = 0;
    this.version = null;
    this.unsupported = false;
    this.manualOnly = false;
    this.width = null;
    this.sig = signature();
    this.refresh(cx);
    cx.spawn(async (cx) => {
      const probed = await probeVersion();
      if (probed.missing) {
        this.manualOnly = true;
        cx.notify();
        return;
      }
      if (versionBelow(probed.version, MIN_HERDR)) {
        this.unsupported = true;
        this.version = probed.version;
        cx.notify();
        return;
      }
      this.version = probed.version;
      cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    });
  }

  refresh(cx) {
    this.again = true;
    if (this.loading) return;
    this.loading = true;
    const gen = ++this.gen;
    cx.spawn(async (cx) => {
      try {
        do {
          this.again = false;
          const paneList = panes();
          const list = spaces();
          for (const space of list) {
            if (gen !== this.gen) return;
            await this.load(space, paneList, cx, gen);
            if (gen === this.gen) cx.notify();
          }
          if (gen !== this.gen) return;
          const ids = new Set(list.map((space) => space.id));
          for (const id of Object.keys(this.cards)) if (!ids.has(id)) delete this.cards[id];
        } while (this.again && gen === this.gen);
      } finally {
        if (gen === this.gen) this.loading = false;
        if (this.again && gen === this.gen) this.refresh(cx);
      }
    });
  }

  async load(space, paneList, cx, gen) {
    const cwd = place(space, paneList);
    const on = space.machine ?? null;
    const previous = this.cards[space.id];
    if (!cwd) {
      this.cards[space.id] = { cwd: null, on, root: null, head: { kind: "none" }, evidence: null, error: null, command: null, timeout: 120000, image: null };
      return;
    }
    let head;
    try {
      head = await readGit(cwd, on);
    } catch (error) {
      head = { kind: "unsure", error: String(error?.message || error).slice(0, 160) };
    }
    if (gen !== this.gen) return;
    if (head.kind === "unsure" && previous?.head?.kind === "repo") head = previous.head;
    const root = head.root || cwd;
    let proof = { dir: `${root}/.proof`, evidence: null, error: null };
    try {
      proof = await readProof(root, on);
    } catch (error) {
      proof.error = String(error?.message || error).slice(0, 160);
    }
    if (gen !== this.gen) return;
    // The repository's .proof/config.json is not consulted. Only the layout
    // props and the shared setting, both chosen by the person, can name Run.
    const config = configuredCommand(props()?.command, shared("proof.command"), {
      propTimeout: props()?.timeout_ms,
      sharedTimeout: shared("proof.timeout_ms"),
    });
    let imagePath = previous?.image ?? null;
    if (hasEvidence(proof.evidence) && isImage(proof.evidence.shot)) {
      imagePath = await this.cacheShot(space.id, root, proof.evidence, on) ?? imagePath;
    }
    this.cards[space.id] = {
      cwd,
      on,
      root,
      head,
      evidence: proof.evidence,
      error: proof.error || config.error || head.error || "",
      command: config.command,
      timeout: config.timeout_ms,
      image: imagePath,
    };
    if (!on) this.ensureWatch(proof.dir, cx);
  }

  ensureWatch(dir, cx) {
    if (!dir || this.watching.has(dir) || this.unwatchable.has(dir)) return;
    this.watching.add(dir);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(dir)) {
          await watchFolder(dir);
          if (this.watching.has(dir)) this.refresh(cx);
        }
      } catch {
        this.watching.delete(dir);
        this.unwatchable.add(dir);
      }
    });
  }

  async cacheShot(spaceId, root, manifest, on) {
    if (on) return null;
    const abs = resolveUnder(root, manifest.shot);
    if (!abs) return null;
    if (this.copied[spaceId] === abs) {
      const ext = manifest.shot.split(".").pop().toLowerCase();
      return `data/proof/${spaceId.replace(/[^A-Za-z0-9_-]/g, "_")}.${ext}`;
    }
    const ext = manifest.shot.split(".").pop().toLowerCase();
    const rel = `data/proof/${spaceId.replace(/[^A-Za-z0-9_-]/g, "_")}.${ext}`;
    const dest = `${appHome()}/${rel}`;
    try {
      const link = await exec("test", ["-L", abs], { timeout: 4000 });
      if (!copyShotAllowed(manifest.shot, { symlink: link.code === 0 })) return null;
      await exec("mkdir", ["-p", `${appHome()}/data/proof`]);
      // Remove our cache file first. `cp -P` does not follow a source symlink,
      // and skipping -f means we never replace a symlink by writing through it.
      await exec("rm", ["-f", dest]);
      const copied = await exec("cp", ["-P", abs, dest]);
      if (copied.code !== 0) return null;
      this.copied[spaceId] = abs;
      return rel;
    } catch {
      return null;
    }
  }

  runCheck(spaceId, cx) {
    const card = this.cards[spaceId];
    if (!card?.command || !card.root || this.busy[spaceId]) return;
    this.busy[spaceId] = "run";
    this.notes[spaceId] = "";
    cx.notify();
    cx.spawn(async (cx) => {
      const started = Date.now();
      let sha = card.head?.sha ?? null;
      let dirty = true;
      try {
        const head = await readGit(card.root, card.on);
        if (head.kind === "repo") {
          sha = head.sha;
          dirty = head.dirty !== false;
        } else if (head.kind === "none") {
          sha = null;
          dirty = false;
        }
      } catch {
        dirty = true;
      }
      let result;
      try {
        result = await shell(card.command, card.root, card.on, card.timeout);
      } catch (error) {
        result = { code: 1, stdout: "", stderr: String(error?.message || error) };
      }
      const record = runRecord({
        command: card.command,
        exitCode: result.code,
        startedMs: started,
        finishedMs: Date.now(),
        sha,
        dirty,
        note: /timed out|timeout/i.test(result.stderr || "") ? "timed out" : null,
      });
      // A new run replaces the result and keeps the last screenshot until Shot.
      if (card.evidence?.shot) record.shot = card.evidence.shot;
      try {
        await exec("mkdir", ["-p", `${card.root}/.proof`], { cwd: card.root, on: card.on });
        await putFile(`${card.root}/.proof/last.log`, trimLog(result.stdout, result.stderr), card.on);
        await putFile(`${card.root}/.proof/latest.json`, manifestJson(record), card.on);
      } catch (error) {
        this.notes[spaceId] = String(error?.message || error).slice(0, 160);
      }
      this.busy[spaceId] = null;
      this.refresh(cx);
      cx.notify();
    });
  }

  takeShot(spaceId, cx) {
    const card = this.cards[spaceId];
    if (!card?.root || this.busy[spaceId]) return;
    this.busy[spaceId] = "shot";
    this.notes[spaceId] = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const rel = `shots/${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        await exec("mkdir", ["-p", `${card.root}/.proof/shots`], { cwd: card.root, on: card.on });
        const result = await shotFile(`${card.root}/.proof/${rel}`);
        if (result.code !== 0) throw new Error((result.stderr || result.stdout || "shot failed").trim());
        const next = mergeShot(card.evidence, rel, { sha: card.head?.sha, at: new Date().toISOString() });
        await putFile(`${card.root}/.proof/latest.json`, manifestJson(next), card.on);
      } catch (error) {
        this.notes[spaceId] = String(error?.message || error).slice(0, 160);
      }
      this.busy[spaceId] = null;
      this.refresh(cx);
      cx.notify();
    });
  }

  async resolveOpen(card) {
    const dir = `${card.root}/.proof`;
    try {
      const choice = openChoice(card.root, card.evidence);
      if (choice.kind !== "file") return dir;
      const file = await exec("test", ["-f", choice.path], { on: card.on, timeout: 4000 });
      const [realFile, realDir] = await Promise.all([
        exec("realpath", ["-e", choice.path], { on: card.on, timeout: 4000 }),
        exec("realpath", ["-e", dir], { on: card.on, timeout: 4000 }),
      ]);
      return resolvedOpen(card.root, card.evidence, {
        isFile: file.code === 0,
        realFile: realFile.code === 0 ? realFile.stdout.trim() : "",
        realDir: realDir.code === 0 ? realDir.stdout.trim() : "",
      }).path;
    } catch {
      return dir;
    }
  }

  openEvidence(spaceId, cx) {
    const card = this.cards[spaceId];
    if (!card?.root) return;
    cx.spawn(async (cx) => {
      try {
        const target = await this.resolveOpen(card);
        const result = await openPath(target, card.on);
        this.notes[spaceId] = result.code === 0 ? "" : (result.stderr || "Could not open").trim().slice(0, 160);
      } catch (error) {
        this.notes[spaceId] = String(error?.message || error).slice(0, 160);
      }
      cx.notify();
    });
  }

  // Shape + label so a verdict never relies on color alone (Agents / Triage pattern).
  verdictMark(t, verdict) {
    const color = verdict ? tone(t, verdict) : t.dim;
    if (verdict === "failing") {
      return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold()
        .text_color(t.blocked).flex().items_center().justify_center().child("!");
    }
    if (verdict === "verified") {
      return div().size(7).mx(3).flex_none().rounded(4).bg(color);
    }
    // stale + unverified (+ unknown): hollow ring
    return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(color);
  }

  verdictTag(t, verdict) {
    const label = verdict ? VERDICTS[verdict] : "…";
    if (!verdict || verdict === "unverified") {
      return div().flex_none().h(16).px(5).rounded(4).bg(t.raised).text_size(10.5).font_medium()
        .text_color(t.muted).flex().items_center().child(label);
    }
    const color = tone(t, verdict);
    return div().flex_none().h(16).px(5).rounded(4).bg(color + "1f").text_size(10.5).font_medium()
      .text_color(color).flex().items_center().child(label);
  }

  dirtyChip(t) {
    return div().flex_none().h(16).px(5).rounded(4).bg(t.working + "1f").text_size(10.5).font_medium()
      .text_color(t.working).flex().items_center().child("dirty");
  }

  primaryButton(id, label, enabled, action) {
    const t = theme();
    return div().id(id).h(28).px(10).flex().items_center().rounded(7).flex_none().text_size(12)
      .bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((style) => style.opacity(0.9)))
      .on_click((_event, cx) => { if (enabled) action(cx); })
      .child(label);
  }

  secondaryButton(id, label, enabled, action) {
    const t = theme();
    return div().id(id).h(28).px(10).flex().items_center().rounded(7).flex_none().text_size(12)
      .bg(t.raised).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((style) => style.bg(t.hover)))
      .on_click((_event, cx) => { if (enabled) action(cx); })
      .child(label);
  }

  evidenceThumb(card, t) {
    if (card?.image) {
      return div().h(56).w_full().rounded(6).overflow_hidden().border_1().border_color(t.border).bg(t.canvas)
        .child(image(card.image).w_full().h(56));
    }
    const shot = card?.evidence?.shot;
    if (shot) {
      return div().h(20).px(6).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).truncate()
        .tooltip(shot).child(shot);
    }
    return null;
  }

  // Compact rail: mark only, tooltip carries name · verdict · branch.
  railRow(space, t, now) {
    const card = this.cards[space.id];
    const head = card?.head;
    const verdict = head ? verdictFor(head, card.evidence, card.command) : null;
    const where = !card ? "…" : !card.cwd ? "No folder" : branchLabel(head);
    const tip = [space.name, verdict ? VERDICTS[verdict] : "…", where].filter(Boolean).join(" · ");
    return h_flex().id(`proof-${space.id}`).h(28).flex_none().mx(6).rounded(6).items_center().justify_center()
      .cursor_pointer().tooltip(tip)
      .when(space.active, (el) => el.bg(t.selected))
      .hover((style) => style.bg(space.active ? t.selected : t.hover))
      .on_click(() => run("space.select", { id: space.id }))
      .child(this.verdictMark(t, verdict));
  }

  row(space, t, now, { showThumb }) {
    const card = this.cards[space.id];
    const head = card?.head;
    const verdict = head ? verdictFor(head, card.evidence, card.command) : null;
    const dirty = Boolean(head?.dirty || card?.evidence?.dirty);
    const who = agentLine(space.id);
    const bits = metaBits(card, head, now);
    const tip = card ? runLine(card.evidence, now) : "";
    const thumb = showThumb && space.active ? this.evidenceThumb(card, t) : null;
    return v_flex().id(`proof-${space.id}`).flex_none().mx(6).gap(0)
      .child(h_flex().h(44).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
        .when(space.active, (el) => el.bg(t.selected))
        .hover((style) => style.bg(space.active ? t.selected : t.hover))
        .on_click(() => run("space.select", { id: space.id }))
        .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.verdictMark(t, verdict)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(6).items_center()
            .when(Boolean(space.status), (el) => el.child(div().size(6).rounded(3).flex_none().bg(t[space.status] || t.dim)))
            .child(div().min_w(0).flex_1().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(space.name))
            .child(this.verdictTag(t, verdict)))
          .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
            .child(div().min_w(0).truncate().tooltip(tip).child(bits.join(" · ")))
            .when(dirty, (el) => el.child(this.dirtyChip(t)))
            .when(Boolean(who), (el) => el.child(div().flex_none().max_w(80).truncate().text_right().child(who))))))
      .when(space.active, (el) => el.child(
        v_flex().mx(0).mb(6).px(8).py(6).gap(4).rounded(7).bg(t.background)
          .child(div().text_size(11).text_color(t.dim).truncate().tooltip(tip).child(tip || "Checking…"))
          .when(Boolean(card?.error), (row) => row.child(
            div().text_size(11).text_color(t.blocked).truncate().tooltip(card.error).child(card.error)))
          .when(Boolean(thumb), (row) => row.child(thumb))));
  }

  render(cx) {
    const t = theme();
    if (this.unsupported) {
      return v_flex().id("proof").size_full().p(12).gap(6).bg(t.chrome).text_color(t.foreground).text_size(12)
        .child(div().font_semibold().child("Proof"))
        .child(div().text_color(t.muted).child(this.version ? `Needs Herdr ${MIN_HERDR} or newer (this one is ${this.version}).` : `Needs Herdr ${MIN_HERDR} or newer.`));
    }
    if (!this.manualOnly) {
      const sig = signature();
      if (sig !== this.sig) {
        this.sig = sig;
        this.refresh(cx);
      }
    }
    const now = Date.now();
    const list = spaces();
    const active = list.find((space) => space.active) ?? list[0] ?? null;
    const card = active ? this.cards[active.id] : null;
    const counts = { verified: 0, unverified: 0, stale: 0, failing: 0 };
    for (const space of list) {
      const known = this.cards[space.id];
      if (known?.head) counts[verdictFor(known.head, known.evidence, known.command)]++;
    }
    const width = this.width ?? 320;
    const rail = width < 200;
    const showSummary = width >= 280;
    const showThumb = width >= 280;
    const summary = headerSummary(counts);
    const busy = active ? this.busy[active.id] : null;
    const canRun = Boolean(card?.command && card.root && !busy);
    const canShot = Boolean(card?.root && !busy);
    const canOpen = Boolean(card?.root && !busy);
    const note = active ? this.notes[active.id] : "";
    const refreshTip = this.manualOnly ? "Refresh only" : "Refresh";
    return v_flex().id("proof").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12)
      .on_size_change((size, sizeCx) => {
        const next = Math.round(size?.width ?? 0);
        if (!next || next === this.width) return;
        this.width = next;
        sizeCx.notify();
      })
      .child(h_flex().h(42).flex_none().px(rail ? 0 : 14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(rail, (el) => el.justify_center())
        .when(!rail, (el) => el
          .child(div().text_size(13).font_semibold().child("Proof"))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
            .child(showSummary ? (summary || (list.length && this.loading ? "Checking…" : "")) : "")))
        .child(div().id("proof-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6)
          .tooltip(refreshTip)
          .cursor_pointer().hover((style) => style.bg(t.hover))
          .on_click((_event, clickCx) => this.refresh(clickCx))
          .child(this.loading
            ? svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.muted).spin(900)
            : div().text_size(12).text_color(t.muted).child("↻"))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("proof-list").absolute().inset_0().overflow_y_scroll().py(6).gap(rail ? 2 : 0)
          .children(list.map((space) => (rail
            ? this.railRow(space, t, now)
            : this.row(space, t, now, { showThumb }))))
          .when(!list.length, (el) => el.child(
            v_flex().px(14).py(16).gap(4).items_center()
              .child(div().text_size(12).text_color(t.dim).child("No spaces yet"))
              .child(div().text_size(12).text_color(t.dim).whitespace_normal().text_center()
                .child("Open a space with a folder to see verification for its branch."))))))
      .when(!rail, (el) => el.child(v_flex().flex_none().px(10).py(8).gap(6).border_t(1).border_color(t.border)
        .child(h_flex().gap(8).items_center().text_size(11).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().tooltip(card?.command || "")
            .child(active
              ? (card?.command ? card.command : "No command — set the layout's command, or shared proof.command")
              : "No space"))
          .child(div().flex_none().child(footerCounts(list.length, counts))))
        .when(Boolean(note), (row) => row.child(div().text_size(11).text_color(t.blocked).truncate().tooltip(note).child(note)))
        .child(h_flex().gap(6)
          .child(this.primaryButton("proof-run", busy === "run" ? "Running…" : "Run", canRun, (clickCx) => this.runCheck(active.id, clickCx)))
          .child(this.secondaryButton("proof-open", "Open", canOpen, (clickCx) => this.openEvidence(active.id, clickCx)))
          .child(this.secondaryButton("proof-shot", busy === "shot" ? "Saving…" : "Shot", canShot, (clickCx) => this.takeShot(active.id, clickCx))))));
  }
}
