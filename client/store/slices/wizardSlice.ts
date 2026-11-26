import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { CustomDesign, WizardExclusion, WizardLaunchInput, WizardLaunchResult, WizardParticipant } from "@shared/api";
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

function loadDraft(): WizardLaunchInput {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DRAFT_KEY) : null;
    return raw ? { ...emptyDraft(), ...JSON.parse(raw) } : emptyDraft();
  } catch {
    return emptyDraft();
  }
}
export function persistDraft(d: WizardLaunchInput) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
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

export const launchWizard = createApiThunk("wizard/launch", async (draft: WizardLaunchInput) => {
  const { custom, saveTemplate, ...rest } = draft;
  const body = draft.eventTypeSlug === "custom" ? { ...rest, custom, saveTemplate: Boolean(saveTemplate) } : rest;
  return (await api.post<WizardLaunchResult>("/wizard/launch", body)).data;
});

export const ME = "me";
/** Everyone who will take part (organizer first when included). `ref` is what exclusions store. */
export function wizardPeople(d: WizardLaunchInput, meEmail?: string): Array<WizardParticipant & { ref: string }> {
  const list = d.participants.filter((p) => !meEmail || p.email !== meEmail).map((p) => ({ ...p, ref: p.email }));
  return d.includeMe ? [{ name: d.organizerName || "You", email: meEmail || "", ref: ME }, ...list] : list;
}

const slice = createSlice({
  name: "wizard",
  initialState: (): WizardState => ({ step: "service", draft: loadDraft(), launching: false, error: null, result: null }),
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
      return { step: "service" as WizardStep, draft: emptyDraft(), launching: false, error: null, result: null };
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
        clearDraft();
      })
      .addCase(launchWizard.rejected, (s, a) => {
        s.launching = false;
        s.error = a.payload ?? "errors.server";
      }),
});

export const { goTo, patchDraft, patchDesign, addParticipants, removeParticipant, addExclusion, removeExclusion, resetWizard } = slice.actions;
export default slice.reducer;
