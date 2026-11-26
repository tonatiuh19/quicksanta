import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { SessionUser } from "@shared/api";
import { api, setActiveTenantHeader } from "@/lib/api";
import { createApiThunk } from "@/lib/portalThunk";

type Step = "email" | "code";
export interface AuthState {
  user: SessionUser | null;
  bootstrapped: boolean;
  loadingMe: boolean;
  step: Step;
  email: string;
  isNew: boolean;
  busy: boolean;
  error: string | null;
  attemptsLeft: number | null;
}

const initialState: AuthState = { user: null, bootstrapped: false, loadingMe: false, step: "email", email: "", isNew: false, busy: false, error: null, attemptsLeft: null };

export const fetchMe = createApiThunk("auth/me", async () => (await api.get<{ user: SessionUser }>("/auth/me")).data.user);
export const requestOtp = createApiThunk("auth/requestOtp", async (email: string) => ({ email, ...(await api.post<{ is_new?: boolean }>("/auth/otp/request", { email })).data }));
export const verifyOtp = createApiThunk("auth/verifyOtp", async (arg: { email: string; code: string; full_name?: string }) => {
  try {
    await api.post("/auth/otp/verify", arg);
  } catch (e: any) {
    if (e?.response?.data?.attempts_left !== undefined) e.message = e.response.data.error;
    throw e;
  }
  return (await api.get<{ user: SessionUser }>("/auth/me")).data.user;
});
export const logout = createApiThunk("auth/logout", async () => {
  await api.post("/auth/logout");
});
export const switchTenant = createApiThunk("auth/switchTenant", async (tenantId: number) => {
  await api.post("/auth/switch-tenant", { tenant_id: tenantId });
  return tenantId;
});
export const updateProfile = createApiThunk("auth/updateProfile", async (arg: { full_name?: string; locale?: "en" | "es" }) => {
  await api.patch("/auth/profile", arg);
  return arg;
});

const slice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    sessionExpired(s) {
      s.user = null;
      s.bootstrapped = true;
      setActiveTenantHeader(null);
    },
    backToEmail(s) {
      s.step = "email";
      s.error = null;
      s.attemptsLeft = null;
    },
    clearAuthError(s) {
      s.error = null;
    },
    setActiveTenantLocal(s, a: PayloadAction<number>) {
      if (s.user) s.user.active_tenant_id = a.payload;
      setActiveTenantHeader(a.payload);
    },
  },
  extraReducers: (b) => {
    const setUser = (s: AuthState, u: SessionUser | null) => {
      s.user = u;
      setActiveTenantHeader(u?.active_tenant_id ?? null);
    };
    b.addCase(fetchMe.pending, (s) => {
      s.loadingMe = true;
    })
      .addCase(fetchMe.fulfilled, (s, a) => {
        setUser(s, a.payload);
        s.loadingMe = false;
        s.bootstrapped = true;
      })
      .addCase(fetchMe.rejected, (s) => {
        setUser(s, null);
        s.loadingMe = false;
        s.bootstrapped = true;
      })
      .addCase(requestOtp.pending, (s) => {
        s.busy = true;
        s.error = null;
      })
      .addCase(requestOtp.fulfilled, (s, a) => {
        s.busy = false;
        s.step = "code";
        s.email = a.payload.email;
        s.isNew = Boolean(a.payload.is_new);
        s.attemptsLeft = null;
      })
      .addCase(requestOtp.rejected, (s, a) => {
        s.busy = false;
        s.error = a.payload ?? "errors.server";
      })
      .addCase(verifyOtp.pending, (s) => {
        s.busy = true;
        s.error = null;
      })
      .addCase(verifyOtp.fulfilled, (s, a) => {
        s.busy = false;
        s.bootstrapped = true;
        s.step = "email";
        setUser(s, a.payload);
      })
      .addCase(verifyOtp.rejected, (s, a) => {
        s.busy = false;
        s.error = a.payload ?? "errors.otpInvalid";
      })
      .addCase(logout.fulfilled, (s) => {
        setUser(s, null);
        s.bootstrapped = true;
      })
      .addCase(switchTenant.fulfilled, (s, a) => {
        if (s.user) s.user.active_tenant_id = a.payload;
        setActiveTenantHeader(a.payload);
      })
      .addCase(updateProfile.fulfilled, (s, a) => {
        if (s.user) Object.assign(s.user, a.payload);
      });
  },
});

export const { sessionExpired, backToEmail, clearAuthError, setActiveTenantLocal } = slice.actions;
export default slice.reducer;
