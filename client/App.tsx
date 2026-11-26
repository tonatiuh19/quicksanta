import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { fetchEventTypes } from "@/store/slices/catalogSlice";
import Landing from "@/pages/public/Landing";
import Login from "@/pages/auth/Login";

// Route-level code splitting: public pages stay in the main chunk, portals load on demand.
const Wizard = lazy(() => import("@/pages/public/Wizard"));
const Legal = lazy(() => import("@/pages/public/Legal"));
const Join = lazy(() => import("@/pages/public/Join"));
const AppLayout = lazy(() => import("@/pages/app/AppLayout"));
const Dashboard = lazy(() => import("@/pages/app/Dashboard"));
const Events = lazy(() => import("@/pages/app/Events"));
const EventDetail = lazy(() => import("@/pages/app/EventDetail"));
const MyEvents = lazy(() => import("@/pages/app/MyEvents"));
const MyAssignment = lazy(() => import("@/pages/app/MyAssignment"));
const Members = lazy(() => import("@/pages/app/Members"));
const WorkspaceSettings = lazy(() => import("@/pages/app/WorkspaceSettings"));
const Billing = lazy(() => import("@/pages/app/Billing"));
const Profile = lazy(() => import("@/pages/app/Profile"));
const AdminLayout = lazy(() => import("@/pages/admin/AdminLayout"));
const Overview = lazy(() => import("@/pages/admin/Overview"));
const Tenants = lazy(() => import("@/pages/admin/Tenants"));
const Users = lazy(() => import("@/pages/admin/Users"));
const AdminEvents = lazy(() => import("@/pages/admin/Events"));
const Payments = lazy(() => import("@/pages/admin/Payments"));
const Emails = lazy(() => import("@/pages/admin/Emails"));
const Audit = lazy(() => import("@/pages/admin/Audit"));
const Catalog = lazy(() => import("@/pages/admin/Catalog"));
const AdminSettings = lazy(() => import("@/pages/admin/Settings"));

export function AppRoutes() {
  const dispatch = useAppDispatch();
  const loaded = useAppSelector((s) => s.catalog.loaded);
  useEffect(() => {
    if (!loaded) void dispatch(fetchEventTypes());
  }, [loaded, dispatch]);

  return (
    <Suspense fallback={<div className="portal-shell-loading"><span className="qs-spinner" aria-hidden /></div>}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/start" element={<Wizard />} />
        <Route path="/join/:token" element={<Join />} />
        <Route path="/privacy" element={<Legal doc="privacy" />} />
        <Route path="/terms" element={<Legal doc="terms" />} />
        <Route path="/app" element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="events" element={<Events />} />
          <Route path="events/:id" element={<EventDetail />} />
          <Route path="my" element={<MyEvents />} />
          <Route path="my/:publicId" element={<MyAssignment />} />
          <Route path="members" element={<Members />} />
          <Route path="billing" element={<Billing />} />
          <Route path="settings" element={<WorkspaceSettings />} />
          <Route path="profile" element={<Profile />} />
        </Route>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Overview />} />
          <Route path="tenants" element={<Tenants />} />
          <Route path="users" element={<Users />} />
          <Route path="events" element={<AdminEvents />} />
          <Route path="payments" element={<Payments />} />
          <Route path="emails" element={<Emails />} />
          <Route path="audit" element={<Audit />} />
          <Route path="catalog" element={<Catalog />} />
          <Route path="settings" element={<AdminSettings />} />
          <Route path="profile" element={<Profile />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
