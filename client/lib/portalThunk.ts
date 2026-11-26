import { createAsyncThunk } from "@reduxjs/toolkit";
import axios from "axios";
import { formatAxiosError } from "@/lib/api";
import { sessionExpired } from "@/store/slices/authSlice";

/**
 * Standard thunk: API errors become `rejectWithValue(i18nKey)`; a 401 mid-session
 * marks the session expired so the shell redirects to /login.
 * Components never call axios directly — they dispatch thunks built with this.
 */
export function createApiThunk<Ret, Arg = void>(type: string, fn: (arg: Arg) => Promise<Ret>) {
  return createAsyncThunk<Ret, Arg, { rejectValue: string }>(type, async (arg, { rejectWithValue, dispatch }) => {
    try {
      return await fn(arg);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) dispatch(sessionExpired());
      return rejectWithValue(formatAxiosError(error, "errors.server"));
    }
  });
}
