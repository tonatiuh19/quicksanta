import { combineReducers, configureStore, type UnknownAction } from "@reduxjs/toolkit";
import auth, { logout, sessionExpired, switchTenant } from "./slices/authSlice";
import wizard, { clearDraft, emptyDraft, persistDraft } from "./slices/wizardSlice";

const EMPTY_DRAFT = JSON.stringify(emptyDraft());
import catalog from "./slices/catalogSlice";
import app from "./slices/appSlice";
import admin from "./slices/adminSlice";
import { gridReducers } from "./slices/grids";

const combined = combineReducers({ auth, wizard, catalog, app, admin, ...gridReducers });

/**
 * Never show one session's / workspace's data in another:
 * - logout / session expiry → everything except the public catalog is reset (incl. the wizard draft).
 * - workspace switch → all workspace data + grid queries reset (auth + wizard kept).
 */
export function rootReducer(state: ReturnType<typeof combined> | undefined, action: UnknownAction): ReturnType<typeof combined> {
  if (state && (logout.fulfilled.match(action) || sessionExpired.match(action))) {
    clearDraft();
    const fresh = combined(undefined, { type: "@@reset" });
    return combined({ ...fresh, catalog: state.catalog }, action);
  }
  if (state && switchTenant.fulfilled.match(action)) {
    const fresh = combined(undefined, { type: "@@reset" });
    return combined({ ...fresh, auth: state.auth, wizard: state.wizard, catalog: state.catalog }, action);
  }
  return combined(state, action);
}

export function makeStore(preloadedState?: Partial<ReturnType<typeof combined>>) {
  const store = configureStore({ reducer: rootReducer as any, preloadedState: preloadedState as any });
  // Wizard drafts survive reloads (and the OTP round trip).
  let last = store.getState().wizard.draft;
  store.subscribe(() => {
    const d = store.getState().wizard.draft;
    if (d === last || store.getState().wizard.result) return;
    last = d;
    // An untouched draft (e.g. right after logout) is removed, not saved.
    if (JSON.stringify(d) === EMPTY_DRAFT) clearDraft();
    else persistDraft(d);
  });
  return store;
}

export const store = makeStore();
export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<typeof combined>;
export type AppDispatch = AppStore["dispatch"];
