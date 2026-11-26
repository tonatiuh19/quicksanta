import { combineReducers, configureStore, type UnknownAction } from "@reduxjs/toolkit";
import auth, { logout, sessionExpired, switchTenant } from "./slices/authSlice";
import wizard, { clearDraft } from "./slices/wizardSlice";
import { createDraftSync } from "./draftSync";
import catalog from "./slices/catalogSlice";
import app from "./slices/appSlice";
import admin from "./slices/adminSlice";
import { gridReducers } from "./slices/grids";

const combined = combineReducers({ auth, wizard, catalog, app, admin, ...gridReducers });

/**
 * Never show one session's / workspace's data in another:
 * - logout / expiry of a signed-in session → everything except the public catalog is reset (incl. the browser copy
 *   of the wizard draft; the account copy stays in the DB). A signed-out visitor's 401 on /auth/me is not an expiry:
 *   their browser draft must survive reloads.
 * - workspace switch → all workspace data + grid queries reset (auth + wizard kept).
 */
export function rootReducer(state: ReturnType<typeof combined> | undefined, action: UnknownAction): ReturnType<typeof combined> {
  if (state && (logout.fulfilled.match(action) || (sessionExpired.match(action) && state.auth.user))) {
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
  // Draft persistence (browser + account autosave + reconcile on sign-in) lives in ./draftSync.
  return configureStore({
    reducer: rootReducer as any,
    preloadedState: preloadedState as any,
    middleware: (gdm) => gdm().prepend(createDraftSync()),
  });
}

export const store = makeStore();
export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<typeof combined>;
export type AppDispatch = AppStore["dispatch"];
