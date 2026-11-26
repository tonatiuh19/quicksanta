import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { CustomDesign, WizardDraftRecord, WizardExclusion, WizardLaunchInput, WizardLaunchResult, WizardParticipant } from "@shared/api";
import { api } from "@/lib/api";
import { createApiThunk } from "@/lib/portalThunk";

export const WIZARD_STEPS = ["service", "design", "details", "people", "rules", "account", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface WizardState {
  step: WizardStep;
  draft: WizardLaunchInput;
  launching: boolean;
  error: string | null;
  result: WizardLaunchResult | null;
  /** ISO time of the last edit (null = nothing worth keeping). */
  savedAt: string | null;
  /** A draft came back (reload / another device): /start asks "continue or start new?" first. */
  resumePending: boolean;
}

const DRAFT_KEY = "qs_wizard_draft";
export const emptyDraft = (): WizardLaunchInput => ({
  eventTypeSlug: "secret_santa",
  name: "",
  description: "",
  exchangeDate: null,
  rsvpDeadline: null,
  budgetMin: null,
  budgetMax: null,
  currency: "USD",
  location: null,
  allowWishlists: true,
  organizerName: "",
  includeMe: true,
  participants: [],
  exclusions: [],
  sendInvites: true,
  custom: emptyDesign(),
  saveTemplate: false,
});

export const emptyDesign = (): CustomDesign => ({ name: "", icon: "sparkles", color: "red", matchMode: "draw", themeRules: "", revealMode: "private" });

/** Whether the draft runs a secret draw (custom design decides for "Create your own"). */
export function draftUsesDraw(d: WizardLaunchInput, type: { slug: string; uses_draw: boolean } | undefined): boolean {
  if (d.eventTypeSlug === "custom") return (d.custom?.matchMode ?? "draw") === "draw";
  return type?.uses_draw !== false;
}

/** Drafts are kept 30 days after the last edit (browser + DB; the daily cron purges the DB). */
export const DRAFT_TTL_DAYS = 30;
const TTL_MS = DRAFT_TTL_DAYS * 86_400_000;

export interface StoredDraft {
  draft: WizardLaunchInput;
  step: WizardStep;
  savedAt: string | null;
}

/** Only real work is a draft: a name, people, a design name, or progress past the first step (not the auto-filled organizer name). */
export function draftHasContent(d: WizardLaunchInput, step: WizardStep = "service"): boolean {
  return Boolean(d.name.trim() || d.participants.length || d.exclusions.length || d.custom?.name?.trim() || step !== "service");
}

/** Untrusted JSON (localStorage / DB) → a well-formed draft. */
export function sanitizeDraft(raw: unknown): WizardLaunchInput {
  const base = emptyDraft();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const r = raw as Partial<WizardLaunchInput>;
  return {
    ...base,
    ...r,
    name: typeof r.name === "string" ? r.name : "",
    eventTypeSlug: typeof r.eventTypeSlug === "string" ? r.eventTypeSlug : base.eventTypeSlug,
    organizerName: typeof r.organizerName === "string" ? r.organizerName : "",
    participants: Array.isArray(r.participants) ? r.participants.filter((p) => p && typeof p.email === "string") : [],
    exclusions: Array.isArray(r.exclusions) ? r.exclusions.filter((x) => x && typeof x.a === "string" && typeof x.b === "string") : [],
    custom: { ...emptyDesign(), ...(r.custom && typeof r.custom === "object" ? r.custom : {}) },
  };
}

export const asStep = (v: unknown): WizardStep => ((WIZARD_STEPS as readonly string[]).includes(v as string) ? (v as WizardStep) : "service");
/** DB DATETIME strings are UTC ("YYYY-MM-DD HH:MM:SS"). */
export const utcIso = (v: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(" ", "T")}Z`).toISOString();

export function loadDraft(now = Date.now()): StoredDraft {
  const empty: StoredDraft = { draft: emptyDraft(), step: "service", savedAt: null };
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DRAFT_KEY) : null;
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    // v1 stored the bare draft; v2 = { v: 2, draft, step, savedAt }.
    const stored: StoredDraft =
      parsed && parsed.v === 2 ? { draft: sanitizeDraft(parsed.draft), step: asStep(parsed.step), savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : null } : { draft: sanitizeDraft(parsed), step: "service", savedAt: new Date(now).toISOString() };
    if (stored.savedAt && now - Date.parse(stored.savedAt) > TTL_MS) {
      clearDraft();
      return empty;
    }
    return draftHasContent(stored.draft, stored.step) ? stored : empty;
  } catch {
    return empty;
  }
}
export function persistDraft(d: WizardLaunchInput, step: WizardStep = "service", savedAt: string | null = new Date().toISOString()) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 2, draft: d, step, savedAt }));
  } catch {
    /* private mode */
  }
}
export function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

// Signed-in drafts also live in the DB (one per user) so they follow the user across devices.
export const fetchServerDraft = createApiThunk("wizard/draft/fetch", async () => (await api.get<{ draft: WizardDraftRecord | null }>("/wizard/draft")).data.draft);
export const saveServerDraft = createApiThunk("wizard/draft/save", async (arg: { step: WizardStep; data: WizardLaunchInput }) => {
  await api.put("/wizard/draft", arg);
});
export const deleteServerDraft = createApiThunk("wizard/draft/delete", async () => {
  await api.delete("/wizard/draft");
});

export const launchWizard = createApiThunk("wizard/launch", async (draft: WizardLaunchInput) => {
  const { custom, saveTemplate, ...rest } = draft;
  const body = draft.eventTypeSlug === "custom" ? { ...rest, custom, saveTemplate: Boolean(saveTemplate) } : rest;
  return (await api.post<WizardLaunchResult>("/wizard/launch", body)).data;
});

/** The steps this draft actually walks through (account skipped when signed in, rules only for draws, design only for custom). */
export function wizardSteps(d: WizardLaunchInput, type: { slug: string; uses_draw: boolean } | undefined, signedIn: boolean): WizardStep[] {
  const usesDraw = draftUsesDraw(d, type);
  return WIZARD_STEPS.filter((s) => !(s === "account" && signedIn) && !(s === "rules" && !usesDraw) && !(s === "design" && d.eventTypeSlug !== "custom"));
}
/** A saved step that this flow skips (e.g. "account" after signing in) → the closest earlier step that exists. */
export function clampStep(step: WizardStep, steps: WizardStep[]): WizardStep {
  if (steps.includes(step)) return step;
  const order = WIZARD_STEPS.indexOf(step);
  return [...steps].reverse().find((s) => WIZARD_STEPS.indexOf(s) <= order) ?? steps[0];
}

export const ME = "me";
/** Everyone who will take part (organizer first when included). `ref` is what exclusions store. */
export function wizardPeople(d: WizardLaunchInput, meEmail?: string): Array<WizardParticipant & { ref: string }> {
  const list = d.participants.filter((p) => !meEmail || p.email !== meEmail).map((p) => ({ ...p, ref: p.email }));
  return d.includeMe ? [{ name: d.organizerName || "You", email: meEmail || "", ref: ME }, ...list] : list;
}

const slice = createSlice({
  name: "wizard",
  initialState: (): WizardState => {
    const stored = loadDraft();
    return { step: stored.step, draft: stored.draft, launching: false, error: null, result: null, savedAt: stored.savedAt, resumePending: Boolean(stored.savedAt) };
  },
  reducers: {
    goTo(s, a: PayloadAction<WizardStep>) {
      s.step = a.payload;
      s.error = null;
    },
    patchDraft(s, a: PayloadAction<Partial<WizardLaunchInput>>) {
      s.draft = { ...s.draft, ...a.payload };
    },
    patchDesign(s, a: PayloadAction<Partial<CustomDesign>>) {
      s.draft.custom = { ...(s.draft.custom ?? emptyDesign()), ...a.payload };
    },
    addParticipants(s, a: PayloadAction<WizardParticipant[]>) {
      const seen = new Set(s.draft.participants.map((p) => p.email));
      for (const p of a.payload) if (!seen.has(p.email)) (seen.add(p.email), s.draft.participants.push(p));
    },
    removeParticipant(s, a: PayloadAction<string>) {
      s.draft.participants = s.draft.participants.filter((p) => p.email !== a.payload);
      s.draft.exclusions = s.draft.exclusions.filter((x) => x.a !== a.payload && x.b !== a.payload);
    },
    addExclusion(s, a: PayloadAction<WizardExclusion>) {
      const { a: x, b: y } = a.payload;
      if (x === y || s.draft.exclusions.some((e) => (e.a === x && e.b === y) || (e.bidirectional && e.a === y && e.b === x))) return;
      s.draft.exclusions.push(a.payload);
    },
    removeExclusion(s, a: PayloadAction<number>) {
      s.draft.exclusions.splice(a.payload, 1);
    },
    resetWizard() {
      clearDraft();
      return { step: "service" as WizardStep, draft: emptyDraft(), launching: false, error: null, result: null, savedAt: null, resumePending: false };
    },
    /** A draft loaded from the account (another device / newer than the browser's). */
    hydrateDraft(s, a: PayloadAction<StoredDraft>) {
      s.draft = a.payload.draft;
      s.step = a.payload.step;
      s.savedAt = a.payload.savedAt;
      s.resumePending = true;
      s.error = null;
    },
    /** Entering /start with a draft (not via "Continue"): ask first. */
    askResume(s) {
      if (!s.result && draftHasContent(s.draft, s.step)) s.resumePending = true;
    },
    /** The user chose "Continue" (resume screen / dashboard card). */
    resumeDraft(s) {
      s.resumePending = false;
    },
    draftSaved(s, a: PayloadAction<string | null>) {
      s.savedAt = a.payload;
    },
  },
  extraReducers: (b) =>
    b
      .addCase(launchWizard.pending, (s) => {
        s.launching = true;
        s.error = null;
      })
      .addCase(launchWizard.fulfilled, (s, a) => {
        s.launching = false;
        s.result = a.payload;
        s.savedAt = null;
        s.resumePending = false;
        clearDraft();
      })
      .addCase(launchWizard.rejected, (s, a) => {
        s.launching = false;
        s.error = a.payload ?? "errors.server";
      }),
});

export const { goTo, patchDraft, patchDesign, addParticipants, removeParticipant, addExclusion, removeExclusion, resetWizard, hydrateDraft, askResume, resumeDraft, draftSaved } = slice.actions;
export default slice.reducer;
