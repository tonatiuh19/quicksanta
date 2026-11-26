/**
 * "What's new" release notes posted to Slack after a successful production
 * deploy (scripts/deploy-prod.ts). Ported from optimum-credit. Only what changed
 * SINCE THE LAST ANNOUNCEMENT: each announcement records a snapshot commit of the
 * deployed working tree (committed + uncommitted + new files, built with a
 * temporary index — the real index/working tree are never touched), kept alive by
 * the local ref refs/qs/release-notes. The next deploy diffs snapshot → snapshot,
 * so uncommitted work is never announced twice. Claude writes staff-facing
 * notes from that diff (English). Never throws — Slack/AI problems never fail
 * a deploy.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export const RELEASE_NOTES_REF = "refs/qs/release-notes";

export type ReleaseChanges = {
  /** Snapshot commit of what is being deployed now. */
  snapshot: string;
  commits: string[];
  files: string[];
  /** Unified diff (meaningful files only, truncated). */
  diff: string;
  /** False when there was no previous snapshot (first run → baseline only). */
  hasBaseline: boolean;
};

function git(args: string[], env?: NodeJS.ProcessEnv): string {
  const r = spawnSync("git", args, { encoding: "utf8", env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? String(r.stdout || "").trim() : "";
}

/** Commit object for the current working tree (incl. uncommitted + untracked, honoring .gitignore). */
export function snapshotWorkingTree(): string {
  const head = git(["rev-parse", "HEAD"]);
  const tmpIndex = path.join(os.tmpdir(), `qs-release-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    if (!head) return "";
    git(["read-tree", head], env);
    // samples/ can hold real client reports — never snapshot it.
    git(["add", "-A", "--", ".", ":(exclude)samples"], env);
    const tree = git(["write-tree"], env);
    if (!tree) return head;
    return git(["commit-tree", tree, "-p", head, "-m", "release-notes snapshot"]) || head;
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

const isCommit = (sha: string | null | undefined) => !!sha && git(["cat-file", "-t", sha]) === "commit";

/** Files that say something to staff (skip tests, lockfiles, samples, migrations, docs, scripts). */
export function meaningfulFiles(files: string[]): string[] {
  return [...new Set(files)]
    .filter((f) => !/(\.test\.|\.spec\.|package-lock|^samples\/|^database\/|\.md$|^scripts\/|\.ya?ml$|\.(pdf|png|jpe?g|webp|heic|svg)$)/i.test(f))
    .slice(0, 80);
}

const MAX_DIFF_CHARS = 60_000;

export function collectReleaseChanges(lastSnapshot: string | null): ReleaseChanges {
  const snapshot = snapshotWorkingTree();
  const base = isCommit(lastSnapshot) ? lastSnapshot! : isCommit(git(["rev-parse", "--verify", "-q", RELEASE_NOTES_REF])) ? git(["rev-parse", RELEASE_NOTES_REF]) : "";
  if (!snapshot || !base) return { snapshot, commits: [], files: [], diff: "", hasBaseline: false };
  const files = meaningfulFiles(git(["diff", "--name-only", base, snapshot]).split("\n").filter(Boolean));
  const commits = git(["log", "--no-merges", "--pretty=%s", `${base}..${snapshot}`])
    .split("\n")
    .filter((m) => m && m !== "release-notes snapshot")
    .slice(0, 40);
  let diff = files.length ? git(["diff", "--unified=1", "--no-color", base, snapshot, "--", ...files]) : "";
  if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n…(diff truncated)";
  return { snapshot, commits, files, diff, hasBaseline: true };
}

/** Remember what was announced (local ref keeps the snapshot from git gc). */
export function markSnapshotAnnounced(snapshot: string): void {
  if (snapshot) git(["update-ref", RELEASE_NOTES_REF, snapshot]);
}

/** Drop anything the model adds above/around the bullets (titles, dates, separators). */
export function sanitizeReleaseNotes(text: string): string {
  return text
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (/^[-–—_*]{3,}$/.test(t)) return false;
      if (/(release notes|platform update|what'?s new|is live)/i.test(t) && !/^[•\-*]\s/.test(t)) return false;
      if (!/^[•\-*]\s/.test(t) && /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i.test(t)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function fallbackReleaseNotes(version: string, c: Pick<ReleaseChanges, "commits">): string {
  const items = c.commits.length ? c.commits.map((s) => `• ${s}`).join("\n") : "• Behind-the-scenes improvements and fixes.";
  return `*:rocket: Version ${version} is live*\n${items}`;
}

const SYSTEM = `You write short "What's new" release notes for the team behind QuickSanta, a multi-tenant platform for creative gift-exchange services (Secret Santa, gift exchanges and more), after a production deploy. Audience: the platform owner/admins (Command Center) and organizers. Plain language, grouped bullets, no internal file names, no em dashes.`;

export async function writeReleaseNotes(version: string, c: ReleaseChanges): Promise<string> {
  const header = `*:rocket: Version ${version} is live — what's new*`;
  if (!c.diff && !c.commits.length) return `${header}\n• Behind-the-scenes improvements and fixes.`;
  const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) return fallbackReleaseNotes(version, c);
  const input = [`Commit messages:\n${c.commits.join("\n") || "(none)"}`, `Diff since last announcement:\n${c.diff || "(none)"}`].join("\n\n");
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: String(process.env.ANTHROPIC_RELEASE_NOTES_MODEL || "").trim() || "claude-sonnet-5-5",
        max_tokens: 800,
        system: SYSTEM,
        messages: [{ role: "user", content: input }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}`);
    const data: any = await resp.json();
    const text = sanitizeReleaseNotes((data?.content || []).filter((x: any) => x?.type === "text").map((x: any) => x.text).join(""));
    return text ? `${header}\n${text}` : fallbackReleaseNotes(version, c);
  } catch (e) {
    console.warn(`⚠️  Release notes AI skipped: ${e instanceof Error ? e.message : String(e)}`);
    return fallbackReleaseNotes(version, c);
  }
}

/** Post to the releases channel. Returns false (never throws) when not configured / failed. */
export async function postReleaseNotesToSlack(text: string): Promise<boolean> {
  const token = String(process.env.SLACK_BOT_TOKEN || "").trim();
  const channel = String(process.env.SLACK_RELEASES_CHANNEL_ID || "").trim();
  if (!token || !channel) {
    console.log("ℹ️  Slack release notes skipped (SLACK_BOT_TOKEN / SLACK_RELEASES_CHANNEL_ID not set).");
    return false;
  }
  try {
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await resp.json();
    if (!data?.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
    return true;
  } catch (e) {
    console.warn(`⚠️  Slack release notes failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
