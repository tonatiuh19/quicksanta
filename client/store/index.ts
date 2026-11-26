import { combineReducers, configureStore } from "@reduxjs/toolkit";
import auth from "./slices/authSlice";
import wizard, { persistDraft } from "./slices/wizardSlice";
import catalog from "./slices/catalogSlice";
import app from "./slices/appSlice";
import admin from "./slices/adminSlice";
import { gridReducers } from "./slices/grids";

export const rootReducer = combineReducers({ auth, wizard, catalog, app, admin, ...gridReducers });

export function makeStore(preloadedState?: Partial<ReturnType<typeof rootReducer>>) {
  const store = configureStore({ reducer: rootReducer, preloadedState: preloadedState as any });
  // Wizard drafts survive reloads (and the OTP round trip).
  let last = store.getState().wizard.draft;
  store.subscribe(() => {
    const d = store.getState().wizard.draft;
    if (d !== last && !store.getState().wizard.result) persistDraft((last = d));
  });
  return store;
}

export const store = makeStore();
export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<typeof rootReducer>;
export type AppDispatch = AppStore["dispatch"];
