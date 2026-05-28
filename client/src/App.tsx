import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";
import {
  Activity, Bell, BookOpen, Camera, Car, CloudFog, Cone, Cpu, Database, LayoutDashboard,
  Menu, Package, PlayCircle, TrendingUp, Upload, Users, Video, Workflow,
} from "lucide-react";
import {
  Badge, Button, Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@databricks/appkit-ui/react";
import { OverviewPage } from "./pages/Overview";
import { DevicesPage } from "./pages/Devices";
import { AlertsPage } from "./pages/Alerts";
import { DetectionsPage } from "./pages/Detections";
import { PlatesPage } from "./pages/Plates";
import { SearchPage } from "./pages/Search";
import { InventoryPage } from "./pages/Inventory";
import { TrendsPage } from "./pages/Trends";
import { LivePage } from "./pages/Live";
import { UploadPage } from "./pages/Upload";
import { PipelinePage } from "./pages/Pipeline";
import { GuestsPage } from "./pages/Guests";
import { SpillsPage } from "./pages/Spills";
import { CameraHealthPage } from "./pages/CameraHealth";
import { InfoPage } from "./pages/Info";
import { AIChatButton } from "./components/AIChatButton";
import { GlobalLoadingBar } from "./components/GlobalLoadingBar";
import { ApertureIcon, LensIQLogo } from "./components/LensIQLogo";
import { TourProvider, useTour } from "./lib/tour";
import "./lib/queries";

type Role = "Admin" | "Store Manager";

const RESTRICTED_VIEWS = ["search", "live", "plates", "detections"];

const VIEW_TITLES: Record<string, string> = {
  overview: "Dashboard Overview",
  devices: "All Devices",
  alerts: "Alerts",
  detections: "Detections",
  plates: "License Plates",
  search: "Data Search",
  inventory: "Inventory",
  trends: "Trends",
  live: "Live Stream",
  upload: "Image Upload",
  pipeline: "Continuous Pipeline",
  guests: "Guest Counts",
  spills: "Spill Detection",
  clarity: "Camera Clarity",
  info: "Talk Track",
};

interface NavButtonProps {
  view: string;
  label: string;
  icon: typeof LayoutDashboard;
  activeView: string;
  onNavigate: (view: string) => void;
  hidden?: boolean;
}

function NavButton({ view, label, icon: Icon, activeView, onNavigate, hidden }: NavButtonProps) {
  if (hidden) return null;
  return (
    <Button
      variant={activeView === view ? "default" : "ghost"}
      className="w-full justify-start gap-2"
      onClick={() => onNavigate(view)}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="truncate">{label}</span>
    </Button>
  );
}

interface NavItemsProps {
  activeView: string;
  userRole: Role;
  onItemClick?: () => void;
}

function NavItems({ activeView, userRole, onItemClick }: NavItemsProps) {
  const navigate = useNavigate();
  const handle = (view: string) => {
    if (userRole === "Store Manager" && RESTRICTED_VIEWS.includes(view)) return;
    navigate(`/${view}`);
    onItemClick?.();
  };
  const restricted = (v: string) => userRole === "Store Manager" && RESTRICTED_VIEWS.includes(v);

  return (
    <nav className="flex flex-col gap-2">
      <div className="px-2 pt-1 pb-1 text-xs uppercase tracking-wider text-slate-500">Computer Vision</div>
      <NavButton view="live"       label="Live Detection" icon={Video}          activeView={activeView} onNavigate={handle} hidden={restricted("live")} />
      <NavButton view="guests"     label="Guest Counts"   icon={Users}          activeView={activeView} onNavigate={handle} />
      <NavButton view="plates"     label="License Plates" icon={Car}            activeView={activeView} onNavigate={handle} hidden={restricted("plates")} />
      <NavButton view="spills"     label="Spill Detection" icon={Cone}          activeView={activeView} onNavigate={handle} />
      <NavButton view="clarity"    label="Camera Clarity" icon={CloudFog}       activeView={activeView} onNavigate={handle} />
      <NavButton view="upload"     label="Image Upload"  icon={Upload}          activeView={activeView} onNavigate={handle} />
      <NavButton view="pipeline"   label="Pipeline"      icon={Workflow}        activeView={activeView} onNavigate={handle} />
      <NavButton view="detections" label="Detections"    icon={Camera}          activeView={activeView} onNavigate={handle} hidden={restricted("detections")} />

      <div className="my-2 border-t border-slate-200" />
      <div className="px-2 pt-1 pb-1 text-xs uppercase tracking-wider text-slate-500">CV-Driven Insights</div>
      <NavButton view="overview"   label="Overview"      icon={LayoutDashboard} activeView={activeView} onNavigate={handle} />
      <NavButton view="inventory"  label="Inventory"     icon={Package}         activeView={activeView} onNavigate={handle} />
      <NavButton view="trends"     label="Trends"        icon={TrendingUp}      activeView={activeView} onNavigate={handle} />

      <div className="my-2 border-t border-slate-200" />
      <div className="px-2 pt-1 pb-1 text-xs uppercase tracking-wider text-slate-500">Operations</div>
      <NavButton view="alerts"     label="Alerts"        icon={Bell}            activeView={activeView} onNavigate={handle} />
      <NavButton view="devices"    label="All Devices"   icon={Cpu}             activeView={activeView} onNavigate={handle} />
      <NavButton view="search"     label="Data Search"   icon={Database}        activeView={activeView} onNavigate={handle} hidden={restricted("search")} />

      <div className="my-2 border-t border-slate-200" />
      <div className="px-2 pt-1 pb-1 text-xs uppercase tracking-wider text-slate-500">Reference</div>
      <NavButton view="info"       label="Talk Track"    icon={BookOpen}        activeView={activeView} onNavigate={handle} />
    </nav>
  );
}

// Header button that kicks off the guided tour. Lives inside <TourProvider>
// so it can call useTour().
function TourLauncher() {
  const { start } = useTour();
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-2"
      onClick={start}
      title="Walk through the demo with talk-track commentary"
    >
      <PlayCircle className="w-4 h-4" />
      <span className="hidden sm:inline">Tour</span>
    </Button>
  );
}

export default function App() {
  return (
    <TourProvider>
      <AppShell />
    </TourProvider>
  );
}

function AppShell() {
  const location = useLocation();
  const activeView = location.pathname.slice(1) || "live";

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userRole, setUserRole] = useState<Role>("Admin");

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <GlobalLoadingBar />
      <aside className="hidden lg:flex lg:flex-col lg:w-64 bg-white border-r border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <LensIQLogo iconSize={36} wordmarkSize={22} showSub />
        </div>
        <div className="flex-1 p-4 overflow-y-auto">
          <NavItems activeView={activeView} userRole={userRole} />
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-slate-200 border-b">
          <div className="px-4 md:px-8 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
                  <SheetTrigger asChild>
                    <Button variant="ghost" size="icon" className="lg:hidden">
                      <Menu className="w-5 h-5" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" className="w-[280px] sm:w-[320px]">
                    <SheetHeader>
                      <SheetTitle>Navigation</SheetTitle>
                    </SheetHeader>
                    <div className="mt-6">
                      <NavItems
                        activeView={activeView}
                        userRole={userRole}
                        onItemClick={() => setDrawerOpen(false)}
                      />
                    </div>
                  </SheetContent>
                </Sheet>

                <div className="lg:hidden flex items-center gap-2">
                  <ApertureIcon size={26} />
                  <div>
                    <h1
                      className="text-slate-900 font-medium"
                      style={{ fontFamily: '"DM Sans", system-ui, sans-serif', letterSpacing: "-0.025em" }}
                    >
                      LensIQ
                    </h1>
                    <p className="text-sm text-slate-600 hidden sm:block">CV monitoring for quick-serve restaurants</p>
                  </div>
                </div>

                <div className="hidden lg:block">
                  <h1
                    className="text-slate-900 font-medium"
                    style={{ fontFamily: '"DM Sans", system-ui, sans-serif', letterSpacing: "-0.02em" }}
                  >
                    {VIEW_TITLES[activeView] ?? "LensIQ"}
                  </h1>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <TourLauncher />

                <Select value={userRole} onValueChange={(v) => setUserRole(v as Role)}>
                  <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Admin">Admin</SelectItem>
                    <SelectItem value="Store Manager">Store Manager</SelectItem>
                  </SelectContent>
                </Select>

                <Badge variant="outline" className="gap-1">
                  <Activity className="w-3 h-3" />
                  <span className="hidden sm:inline">Live</span>
                </Badge>
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 px-4 md:px-8 py-6 overflow-auto">
          <Routes>
            <Route path="/" element={<Navigate to="/live" replace />} />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/detections" element={<DetectionsPage />} />
            <Route path="/plates" element={<PlatesPage isActive={activeView === "plates"} />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/trends" element={<TrendsPage />} />
            <Route path="/live" element={<LivePage isActive={activeView === "live"} />} />
            <Route path="/guests" element={<GuestsPage isActive={activeView === "guests"} />} />
            <Route path="/spills" element={<SpillsPage isActive={activeView === "spills"} />} />
            <Route path="/clarity" element={<CameraHealthPage isActive={activeView === "clarity"} />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/pipeline" element={<PipelinePage />} />
            <Route path="/info" element={<InfoPage />} />
          </Routes>
        </div>

        <AIChatButton />
      </div>
    </div>
  );
}
