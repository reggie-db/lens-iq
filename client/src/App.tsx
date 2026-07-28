import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  Activity, Beer, Bell, BookOpen, Camera, Car, ChevronDown, CloudFog, Cone, Cpu, Database,
  Fuel, LayoutDashboard, Menu, MonitorPlay, Package, Pizza, PlayCircle, Presentation, ScanFace,
  TrendingUp, Upload, Users, Video, Workflow,
} from "lucide-react";
import {
  Badge, Button, ButtonGroup, Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
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
import { FacialRecognitionPage } from "./pages/FacialRecognition";
import { PizzaInventoryPage } from "./pages/PizzaInventory";
import { PumpStatusPage } from "./pages/PumpStatus";
import { BeveragePage } from "./pages/Beverage";
import { InfoPage } from "./pages/Info";
import { DeckPage } from "./pages/Deck";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AIChatLauncher, AIChatPanel } from "./components/AIChatButton";
import { GlobalLoadingBar } from "./components/GlobalLoadingBar";
import { ApertureIcon, LensIQLogo } from "./components/LensIQLogo";
import { TourProvider, useTour } from "./lib/tour";
import { KioskProvider, useKiosk } from "./lib/kiosk";
import { useOboAvailable } from "./lib/auth";
import { useMastraConfig } from "@dbx-tools/ui-mastra/react";
import { ThemeToggle, useTheme } from "./lib/theme";
import "./lib/queries";

type Role = "Admin" | "Store Manager";

const RESTRICTED_VIEWS = ["search", "live", "plates", "detections"];

const VIEW_TITLES: Record<string, string> = {
  overview: "Fleet Operations Dashboard",
  devices: "All Devices",
  alerts: "Alerts",
  detections: "Detections",
  plates: "License Plates",
  search: "Data Search",
  inventory: "Inventory",
  "pizza-inventory": "Pizza Inventory",
  "pump-status": "Pump Status",
  beverage: "Beverage Service",
  trends: "Trends",
  live: "Live Stream",
  upload: "Image Upload",
  pipeline: "Continuous Pipeline",
  guests: "Guest Counts",
  spills: "Spill Detection",
  faces: "Facial Recognition",
  clarity: "Camera Clarity",
  info: "Talk Track",
  deck: "Booth Deck",
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
      data-nav={view}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="truncate">{label}</span>
    </Button>
  );
}

interface NavItemsProps {
  activeView: string;
  userRole: Role;
  presenterMode: boolean;
  onItemClick?: () => void;
}

function NavItems({ activeView, userRole, presenterMode, onItemClick }: NavItemsProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const handle = (view: string) => {
    if (userRole === "Store Manager" && RESTRICTED_VIEWS.includes(view)) return;
    // Preserve the current query string (e.g. ?presenterMode=true) so the
    // presenter-only Talk Track / Booth Deck links stay visible while
    // navigating around the app.
    navigate(`/${view}${location.search}`);
    onItemClick?.();
  };
  const restricted = (v: string) => userRole === "Store Manager" && RESTRICTED_VIEWS.includes(v);

  return (
    <nav className="flex flex-col gap-2">
      <div className="px-2 pt-1 pb-1 text-xs uppercase tracking-wider text-muted-foreground">Start here</div>
      <NavButton view="overview"   label="Fleet Dashboard" icon={LayoutDashboard} activeView={activeView} onNavigate={handle} />

      <div className="my-2 border-t border-border" />
      <div className="px-2 pt-1 pb-1 text-xs uppercase tracking-wider text-muted-foreground">Computer Vision</div>
      <NavButton view="live"             label="Live Detection"     icon={Video}          activeView={activeView} onNavigate={handle} hidden={restricted("live")} />
      <NavButton view="guests"           label="Guest Counts"       icon={Users}          activeView={activeView} onNavigate={handle} />
      <NavButton view="plates"           label="License Plates"     icon={Car}            activeView={activeView} onNavigate={handle} hidden={restricted("plates")} />
      <NavButton view="spills"           label="Spill Detection"    icon={Cone}           activeView={activeView} onNavigate={handle} />
      <NavButton view="faces"            label="Facial Recognition" icon={ScanFace}       activeView={activeView} onNavigate={handle} />
      <NavButton view="clarity"          label="Camera Clarity"     icon={CloudFog}       activeView={activeView} onNavigate={handle} />
      <NavButton view="pizza-inventory"  label="Pizza Inventory"    icon={Pizza}          activeView={activeView} onNavigate={handle} />
      <NavButton view="pump-status"      label="Pump Status"        icon={Fuel}           activeView={activeView} onNavigate={handle} />
      <NavButton view="beverage"         label="Beverage Service"   icon={Beer}           activeView={activeView} onNavigate={handle} />
      <NavButton view="upload"           label="Image Upload"       icon={Upload}         activeView={activeView} onNavigate={handle} />
      <NavButton view="pipeline"         label="Pipeline"           icon={Workflow}       activeView={activeView} onNavigate={handle} />
      <NavButton view="detections"       label="Detections"         icon={Camera}         activeView={activeView} onNavigate={handle} hidden={restricted("detections")} />

      <div className="my-2 border-t border-border" />
      <div className="px-2 pt-1 pb-1 text-xs uppercase tracking-wider text-muted-foreground">CV-Driven Insights</div>
      <NavButton view="inventory"  label="Inventory"     icon={Package}         activeView={activeView} onNavigate={handle} />
      <NavButton view="trends"     label="Trends"        icon={TrendingUp}      activeView={activeView} onNavigate={handle} />

      <div className="my-2 border-t border-border" />
      <div className="px-2 pt-1 pb-1 text-xs uppercase tracking-wider text-muted-foreground">Operations</div>
      <NavButton view="alerts"     label="Alerts"        icon={Bell}            activeView={activeView} onNavigate={handle} />
      <NavButton view="devices"    label="All Devices"   icon={Cpu}             activeView={activeView} onNavigate={handle} />
      <NavButton view="search"     label="Data Search"   icon={Database}        activeView={activeView} onNavigate={handle} hidden={restricted("search")} />

      {/* Talk Track + Booth Deck are presenter-only: hidden unless the URL
          carries ?presenterMode=true (see usePresenterMode in AppShell). */}
      {presenterMode && (
        <>
          <div className="my-2 border-t border-border" />
          <div className="px-2 pt-1 pb-1 text-xs uppercase tracking-wider text-muted-foreground">Reference</div>
          <NavButton view="info"       label="Talk Track"    icon={BookOpen}        activeView={activeView} onNavigate={handle} />
          <NavButton view="deck"       label="Booth Deck"    icon={Presentation}    activeView={activeView} onNavigate={handle} />
        </>
      )}
    </nav>
  );
}

// Header split control. Lives inside <KioskProvider> + <TourProvider>.
// Primary button toggles the hands-free, visual-only Kiosk loop (also
// auto-startable via ?kiosk=true). The dropdown caret launches the manual
// guided Tour (presenter tips), turning the kiosk off first so the two
// overlays never fight.
function DemoLauncher() {
  const { armed, toggle, disarm } = useKiosk();
  const { start } = useTour();
  const variant = armed ? "default" : "outline";
  const launchTour = () => {
    disarm();
    start();
  };
  return (
    <ButtonGroup>
      <Button
        variant={variant}
        size="sm"
        className="gap-2"
        onClick={toggle}
        title={
          armed
            ? "Kiosk demo is on - click to stop"
            : "Run the hands-free booth loop that drives itself around the app"
        }
      >
        {armed ? (
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
        ) : (
          <MonitorPlay className="w-4 h-4" />
        )}
        <span className="hidden sm:inline">Kiosk</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={variant} size="sm" aria-label="More demo modes">
            <ChevronDown className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={launchTour} className="gap-2">
            <PlayCircle className="w-4 h-4" /> Guided tour
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

export default function App() {
  return (
    <TourProvider>
      <KioskProvider>
        <AppShell />
      </KioskProvider>
    </TourProvider>
  );
}

function AppShell() {
  const location = useLocation();
  const activeView = location.pathname.slice(1) || "overview";
  const { resolved: theme } = useTheme();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userRole, setUserRole] = useState<Role>("Admin");
  const [chatOpen, setChatOpen] = useState(false);

  // Ask LensIQ: show when Mastra is in service-principal mode (chatAlwaysAvailable)
  // or when an OBO user token is present. SP mode is the deploy default so
  // account users who can open the app can chat without workspace membership.
  const mastraConfig = useMastraConfig();
  const oboAvailable = useOboAvailable();
  const chatAvailable = mastraConfig.chatAlwaysAvailable || Boolean(oboAvailable);

  // Presenter mode gates the booth-only Talk Track (/info) and Booth Deck
  // (/deck) surfaces. Driven purely by the ?presenterMode=true query param so
  // it's shareable and stateless; NavItems preserves the query string across
  // navigation so the links stay visible once enabled.
  const presenterMode = new URLSearchParams(location.search).get("presenterMode") === "true";

  // Single-page app shell:
  //   - The viewport itself never scrolls. We pin to h-screen + overflow-hidden
  //     on the root so iOS Safari can't elastic-bounce / "drag" the page.
  //   - The desktop sidebar is always visible (no collapse toggle) at fixed
  //     width, and owns its own scroll for tall nav lists.
  //   - The header is fixed at the top of the content column.
  //   - Only the main content area scrolls (with overscroll-contain so swipes
  //     inside cards don't pull the entire page up).
  //   - On mobile the sidebar is a Sheet drawer driven by the hamburger.

  return (
    <div className="h-screen bg-background flex overflow-hidden overscroll-none">
      <GlobalLoadingBar />
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 bg-card border-r border-border">
        <div className="p-6 border-b border-border shrink-0">
          <LensIQLogo iconSize={36} wordmarkSize={22} showSub onDark={theme === "dark"} />
        </div>
        <div className="flex-1 p-4 overflow-y-auto overscroll-contain">
          <NavItems activeView={activeView} userRole={userRole} presenterMode={presenterMode} />
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 h-screen">
        <header className="bg-card border-border border-b shrink-0">
          <div className="px-4 md:px-8 py-3">
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
                        presenterMode={presenterMode}
                        onItemClick={() => setDrawerOpen(false)}
                      />
                    </div>
                  </SheetContent>
                </Sheet>

                <div className="lg:hidden flex items-center gap-2">
                  <ApertureIcon size={26} />
                  <div>
                    <h1
                      className="text-foreground font-medium"
                      style={{ fontFamily: '"DM Sans", system-ui, sans-serif', letterSpacing: "-0.025em" }}
                    >
                      LensIQ
                    </h1>
                    <p className="text-sm text-muted-foreground hidden sm:block">CV monitoring for quick-serve restaurants</p>
                  </div>
                </div>

                <div className="hidden lg:block">
                  <h1
                    className="text-foreground font-medium"
                    style={{ fontFamily: '"DM Sans", system-ui, sans-serif', letterSpacing: "-0.02em" }}
                  >
                    {VIEW_TITLES[activeView] ?? "LensIQ"}
                  </h1>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <DemoLauncher />

                <ThemeToggle />

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

        {/* Content + chat share one resizable split. The chat panel is
            conditionally mounted, so PanelGroup is keyed on `chatOpen` to
            force a fresh layout instead of restoring stale panel sizes. */}
        <PanelGroup
          key={chatOpen ? "with-chat" : "content-only"}
          direction="horizontal"
          className="flex-1 min-h-0"
        >
          <Panel defaultSize={chatOpen ? 65 : 100} minSize={30} className="flex min-w-0 flex-col">
            <main className="flex-1 min-h-0 px-4 md:px-8 py-4 overflow-y-auto overscroll-contain">
              <Routes>
                <Route path="/" element={<Navigate to="/overview" replace />} />
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
                <Route path="/faces" element={<FacialRecognitionPage isActive={activeView === "faces"} />} />
                <Route path="/clarity" element={<CameraHealthPage isActive={activeView === "clarity"} />} />
                <Route path="/pizza-inventory" element={<PizzaInventoryPage isActive={activeView === "pizza-inventory"} />} />
                <Route path="/pump-status" element={<PumpStatusPage isActive={activeView === "pump-status"} />} />
                <Route path="/beverage" element={<BeveragePage isActive={activeView === "beverage"} />} />
                <Route path="/upload" element={<UploadPage />} />
                <Route path="/pipeline" element={<PipelinePage />} />
                {/* Presenter-only routes: direct hits without ?presenterMode=true
                    bounce back to the dashboard. */}
                <Route path="/info" element={presenterMode ? <InfoPage /> : <Navigate to="/overview" replace />} />
                <Route path="/deck" element={presenterMode ? <DeckPage /> : <Navigate to="/overview" replace />} />
              </Routes>
            </main>
          </Panel>

          {chatAvailable && chatOpen && (
            <>
              {/* The 6px handle is the visible divider; the inset span widens
                  the grab target either side of it without moving the seam. */}
              <PanelResizeHandle className="group relative w-1.5 shrink-0 cursor-col-resize bg-slate-200 outline-none transition-colors hover:bg-slate-300 focus-visible:bg-slate-400 data-[resize-handle-active]:bg-slate-400">
                <span className="absolute inset-y-0 -left-1 -right-1" aria-hidden />
              </PanelResizeHandle>
              <Panel
                defaultSize={35}
                minSize={20}
                maxSize={60}
                className="min-w-0 border-l border-slate-200"
              >
                <AIChatPanel onClose={() => setChatOpen(false)} />
              </Panel>
            </>
          )}
        </PanelGroup>

        {chatAvailable && !chatOpen && <AIChatLauncher onClick={() => setChatOpen(true)} />}
      </div>
    </div>
  );
}
