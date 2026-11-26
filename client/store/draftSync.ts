/**
 * Wizard draft persistence (one active draft):
 * - Always mirrored to localStorage (survives reloads and the OTP round trip).
 * - Signed in: also autosaved to the account (debounced PUT /api/wizard/draft) so it follows the user across devices.
 * - On sign-in / app load the browser draft and the account draft are reconciled: the newer one wins
 *   (a draft started while signed out moves into the account; an older browser copy is replaced by the account's).
 * - Logout clears the browser copy only (shared devices); the account copy comes back on the next sign-in.
 */
import { createListenerMiddleware, isAnyOf, type UnknownAction } from "@reduxjs/toolkit";
import { fetchMe, verifyOtp } from "./slices/authSlice";
import {
  clearDraft,
  deleteServerDraft,
  draftHasContent,
  draftSaved,
  fetchServerDraft,
  hydrateDraft,
  persistDraft,
  sanitizeDraft,
  saveServerDraft,
  asStep,
  utcIso,
  resetWizard,
  type WizardState,
} from "./slices/wizardSlice";

type S = { wizard: WizardState; auth: { user: { id: number } | null } };
export const DRAFT_SAVE_DEBOUNCE_MS = 800;

/** One instance per store (tests build many stores). */
export function createDraftSync() {
  const draftSync = createListenerMiddleware();

  // 1) Every edit → browser now, account after a short pause.
  draftSync.startListening({
    predicate: (action: UnknownAction, cur, prev) => {
      const a = (cur as S).wizard;
      const b = (prev as S).wizard;
      if (a.result || hydrateDraft.match(action) || draftSaved.match(action)) return false;
      return a.draft !== b.draft || a.step !== b.step;
    },
    effect: async (action, api) => {
      const { wizard, auth } = api.getState() as S;
      const has = draftHasContent(wizard.draft, wizard.step);
      if (!has) {
        clearDraft();
        if (wizard.savedAt) api.dispatch(draftSaved(null));
        // Only an explicit reset deletes the account copy (an untouched visit to /start never does).
        if (auth.user && resetWizard.match(action)) {
          api.cancelActiveListeners();
          await api.dispatch(deleteServerDraft());
        }
        return;
      }
      const now = new Date().toISOString();
      persistDraft(wizard.draft, wizard.step, now);
      api.dispatch(draftSaved(now));
      if (!auth.user) return;
      api.cancelActiveListeners(); // debounce: only the last edit in a burst is sent
      await api.delay(DRAFT_SAVE_DEBOUNCE_MS);
      const latest = (api.getState() as S).wizard;
      if (latest.result || !draftHasContent(latest.draft, latest.step)) return;
      await api.dispatch(saveServerDraft({ step: latest.step, data: latest.draft }));
    },
  });

  // 2) A user appears (app load or sign-in) → reconcile with the account draft.
  draftSync.startListening({
    matcher: isAnyOf(fetchMe.fulfilled, verifyOtp.fulfilled),
    effect: async (_action, api) => {
      api.unsubscribe(); // re-subscribed below: one reconcile at a time
      try {
        const r = await api.dispatch(fetchServerDraft());
        if (!fetchServerDraft.fulfilled.match(r)) return;
        const server = r.payload;
        const { wizard } = api.getState() as S;
        if (wizard.result) return;
        const localHas = draftHasContent(wizard.draft, wizard.step);
      // Same draft on both sides (e.g. this tab's own autosave, seen on a background /auth/me refresh): nothing to do.
      // Compared by content, not timestamps — browser and DB clocks can disagree.
      if (server && localHas && server.step === wizard.step && JSON.stringify(sanitizeDraft(server.data)) === JSON.stringify(wizard.draft)) return;
        const serverAt = server ? Date.parse(utcIso(server.updated_at)) : 0;
        const localAt = wizard.savedAt ? Date.parse(wizard.savedAt) : 0;
        if (localHas && (!server || localAt >= serverAt)) {
          await api.dispatch(saveServerDraft({ step: wizard.step, data: wizard.draft }));
        } else if (server) {
          const draft = sanitizeDraft(server.data);
          const step = asStep(server.step);
          if (!draftHasContent(draft, step)) return;
          const savedAt = utcIso(server.updated_at);
          persistDraft(draft, step, savedAt);
          api.dispatch(hydrateDraft({ draft, step, savedAt }));
        }
      } finally {
        api.subscribe();
      }
    },
  });
  return draftSync.middleware;
}
