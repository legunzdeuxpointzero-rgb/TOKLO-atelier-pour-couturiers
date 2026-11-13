import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  Clock3,
  Cloud,
  Download,
  FileText,
  Headphones,
  Home,
  Menu,
  Mic,
  MoreHorizontal,
  Plus,
  Printer,
  Search,
  ShieldCheck,
  Settings,
  Shirt,
  UserRound,
  UsersRound,
  WifiOff,
  X,
} from "lucide-react";
import { allowedNextStatuses, customerCode, formatMoney, GARMENTS, MEASUREMENT_FIELDS, ORDER_STATUSES, orderRisk, paymentIsValid, remainingBalance } from "./domain";
import { loadAll, replaceAll, requestPersistentStorage, saveRecord } from "./db";
import type {
  Appointment,
  AppointmentReason,
  Category,
  Customer,
  Garment,
  Measurement,
  Order,
  OrderStatus,
  Payment,
  PaymentChannel,
  TableName,
  TokloData,
} from "./types";

type View = "Accueil" | "Clients" | "Fiche client" | "Mesures" | "Commandes" | "Agenda" | "Finances" | "Réglages";
type DialogState =
  | { type: "customer"; customerId?: string }
  | { type: "measurement"; customerId?: string }
  | { type: "order"; customerId?: string }
  | { type: "appointment"; customerId?: string }
  | { type: "payment"; orderId: string }
  | { type: "receipt"; orderId: string };

const EMPTY_DATA: TokloData = { customers: [], measurements: [], orders: [], payments: [], appointments: [] };
const NAV_ITEMS: { title: View; icon: typeof Home }[] = [
  { title: "Accueil", icon: Home },
  { title: "Clients", icon: UsersRound },
  { title: "Mesures", icon: Shirt },
  { title: "Commandes", icon: ClipboardList },
  { title: "Agenda", icon: CalendarDays },
  { title: "Finances", icon: CircleDollarSign },
];
const MOBILE_NAV_ITEMS: { title: View; icon: typeof Home }[] = [
  { title: "Accueil", icon: Home },
  { title: "Mesures", icon: Shirt },
  { title: "Agenda", icon: CalendarDays },
  { title: "Clients", icon: UserRound },
];
const CHANNELS: PaymentChannel[] = ["Espèces", "Wave", "Orange Money", "MTN MoMo", "Moov Money"];
const CATEGORIES: Category[] = ["Femme", "Homme", "Enfant"];

function createId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function dateInputValue(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function timeInputValue(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(11, 16);
}

function dateStrip(days = 7): string[] {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 3);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return dateInputValue(date);
  });
}

function readableDate(value?: string): string {
  if (!value) return "À définir";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function readableDateTime(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function customerName(customer?: Customer): string {
  return customer ? `${customer.firstName} ${customer.lastName}`.trim() : "Client archivé";
}

function baseRecord() {
  const timestamp = nowIso();
  return { id: createId(), createdAt: timestamp, updatedAt: timestamp };
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function fileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Lecture du fichier impossible"));
    reader.onerror = () => reject(reader.error ?? new Error("Lecture du fichier impossible"));
    reader.readAsDataURL(file);
  });
}

async function compressPhoto(file: File): Promise<string> {
  const image = await createImageBitmap(file);
  try {
    let scale = Math.min(1, 1280 / Math.max(image.width, image.height));
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Compression photo indisponible sur ce navigateur");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", Math.max(0.35, 0.82 - attempt * 0.08)));
      if (!blob) throw new Error("Compression de la photo impossible");
      if (blob.size <= 400 * 1024) return fileAsDataUrl(blob);
      scale *= 0.78;
    }
    throw new Error("Cette photo reste trop volumineuse après compression. Choisissez une image plus petite.");
  } finally {
    image.close();
  }
}

function speak(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

export default function App() {
  const [data, setData] = useState<TokloData>(EMPTY_DATA);
  const [activeView, setActiveView] = useState<View>("Accueil");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [search, setSearch] = useState("");
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [loading, setLoading] = useState(true);
  const [storagePersistent, setStoragePersistent] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      setData(await loadAll());
      setError("");
    } catch (cause) {
      console.error("Erreur de lecture des données Toklo.", cause);
      setError("Impossible de lire les données de cet appareil. Vérifiez le stockage du navigateur.");
    }
  };
  const saveCustomerAndKeepDialogOpen = async (customer: Customer) => {
    try {
      await saveRecord("customers", customer);
      await refresh();
      setToast("Client enregistré sur cet appareil");
    } catch (cause) {
      console.error("Échec de l'enregistrement du client.", cause);
      setError("Le client n'a pas pu être enregistré. Libérez de l'espace puis réessayez.");
      throw cause;
    }
  };

  useEffect(() => {
    void (async () => {
      await refresh();
      const persistent = await requestPersistentStorage().catch((cause: unknown) => {
        console.error("Le stockage persistant n'a pas pu être demandé.", cause);
        return false;
      });
      setStoragePersistent(persistent);
      setLoading(false);
    })();
    const updateOnline = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const save = async <T extends TableName,>(table: T, record: TokloData[T][number]) => {
    try {
      await saveRecord(table, record as never);
      await refresh();
      setDialog(null);
      setToast("Enregistré sur cet appareil");
    } catch (cause) {
      console.error("Échec de l'enregistrement Toklo.", cause);
      setError("L'enregistrement a échoué. Libérez de l'espace puis réessayez.");
    }
  };

  const customers = useMemo(() => data.customers.filter((customer) => {
    const query = search.trim().toLocaleLowerCase("fr");
    return !query || `${customer.firstName} ${customer.lastName} ${customer.phone} ${customer.code}`.toLocaleLowerCase("fr").includes(query);
  }), [data.customers, search]);

  const customerById = (id: string) => data.customers.find((customer) => customer.id === id);
  const upcomingAppointments = data.appointments
    .filter((appointment) => appointment.status === "Prévu" && new Date(appointment.dateTime) >= new Date())
    .sort((a, b) => a.dateTime.localeCompare(b.dateTime));
  const activeOrders = data.orders.filter((order) => !["Livré", "Annulé"].includes(order.status));
  const dueOrders = activeOrders.filter((order) => orderRisk(order));

  const exportJson = async () => {
    downloadFile(`toklo-sauvegarde-${dateInputValue()}.json`, JSON.stringify(await loadAll(), null, 2), "application/json");
    setToast("Copie de sauvegarde téléchargée");
  };

  const exportCsv = async () => {
    const all = await loadAll();
    const rows = [
      ["Type", "Client", "Téléphone", "Détail", "Date", "Montant / valeurs"],
      ...all.customers.map((item) => ["Client", customerName(item), item.phone, item.category, item.createdAt.slice(0, 10), item.code]),
      ...all.measurements.map((item) => [
        "Mesures",
        customerName(all.customers.find((person) => person.id === item.customerId)),
        "",
        item.garment,
        item.date,
        Object.entries(item.values).map(([label, value]) => `${label}: ${value} ${item.unit}`).join(" | "),
      ]),
      ...all.orders.map((item) => [
        "Commande",
        customerName(all.customers.find((person) => person.id === item.customerId)),
        "",
        `${item.reference} — ${item.garment} — ${item.status}`,
        item.dueDate,
        `${item.totalPrice} FCFA`,
      ]),
    ];
    downloadFile(
      `toklo-export-${dateInputValue()}.csv`,
      `\uFEFF${rows.map((row) => row.map(csvSafe).join(";")).join("\r\n")}`,
      "text/csv;charset=utf-8",
    );
    setToast("Export CSV téléchargé");
  };

  const importBackup = async (file?: File) => {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isTokloData(parsed)) throw new Error("Format invalide");
      if (!window.confirm("Cette restauration remplacera les données locales de cet appareil. Continuer ?")) return;
      await replaceAll(parsed);
      await refresh();
      setToast("Sauvegarde restaurée");
    } catch (cause) {
      console.error("Échec de la restauration de la sauvegarde.", cause);
      setError("Ce fichier de sauvegarde est invalide ou illisible.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const renderView = () => {
    if (loading) return <div className="loading-state"><div className="spinner" />Chargement de votre atelier…</div>;
    switch (activeView) {
      case "Accueil":
        return <Dashboard data={data} appointments={upcomingAppointments} activeOrders={activeOrders} risks={dueOrders} setView={setActiveView} openDialog={setDialog} customerById={customerById} />;
      case "Clients":
        return <CustomersPage customers={customers} allCustomers={data.customers} query={search} setQuery={setSearch} openDialog={setDialog} measurements={data.measurements} orders={data.orders} appointments={data.appointments} onOpenCustomer={(id) => { setSelectedCustomerId(id); setActiveView("Fiche client"); }} />;
      case "Fiche client":
        return <CustomerDetailPage customer={customerById(selectedCustomerId)} data={data} openDialog={setDialog} save={save} onBack={() => setActiveView("Clients")} />;
      case "Mesures":
        return <MeasurementsPage data={data} customerById={customerById} openDialog={setDialog} />;
      case "Commandes":
        return <OrdersPage data={data} customerById={customerById} openDialog={setDialog} save={save} />;
      case "Agenda":
        return <AgendaPage data={data} customerById={customerById} openDialog={setDialog} save={save} />;
      case "Finances":
        return <FinancePage data={data} customerById={customerById} openDialog={setDialog} />;
      case "Réglages":
        return <SettingsPage storagePersistent={storagePersistent} exportCsv={exportCsv} exportJson={exportJson} onImport={() => importRef.current?.click()} />;
    }
  };

  return (
    <div className={`app-shell ${dialog?.type === "measurement" ? "measurement-open" : ""}`}>
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Shirt size={22} strokeWidth={2.2} /></div>
          <div><strong>toklo</strong><span>MON ATELIER</span></div>
          <button className="icon-button close-menu" aria-label="Fermer le menu" onClick={() => setMenuOpen(false)}><X size={20} /></button>
        </div>
        <div className="atelier-card">
          <div className="atelier-avatar">T</div>
          <div><strong>Mon atelier</strong><small>Compte indépendant</small></div>
          <ChevronDown size={16} />
        </div>
        <nav className="main-nav" aria-label="Navigation principale">
          <p className="nav-caption">MENU PRINCIPAL</p>
          {NAV_ITEMS.map(({ title, icon: Icon }) => (
            <button key={title} className={`nav-item ${activeView === title ? "active" : ""}`} onClick={() => { setActiveView(title); setMenuOpen(false); }}>
              <Icon size={19} /><span>{title}</span>
              {title === "Commandes" && dueOrders.length > 0 && <span className="nav-count">{dueOrders.length}</span>}
            </button>
          ))}
          <p className="nav-caption nav-caption-spaced">VOTRE ESPACE</p>
          <button className={`nav-item ${activeView === "Réglages" ? "active" : ""}`} onClick={() => { setActiveView("Réglages"); setMenuOpen(false); }}><Settings size={19} /><span>Réglages</span></button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sync-card">
            <div className={`sync-icon ${isOnline ? "online" : "offline"}`}>{isOnline ? <Cloud size={18} /> : <WifiOff size={18} />}</div>
            <div><strong>{isOnline ? "Données sur l'appareil" : "Mode hors ligne"}</strong><small>{isOnline ? "Sauvegarde locale active" : "Vos données restent accessibles"}</small></div>
            <span className={`sync-dot ${isOnline ? "dot-green" : "dot-amber"}`} />
          </div>
          <button className="profile-button" onClick={() => setActiveView("Réglages")}>
            <div className="profile-avatar">AT</div><div><strong>Atelier Toklo</strong><small>Profil local</small></div><MoreHorizontal size={19} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar desktop-topbar">
          <button className="icon-button mobile-menu" aria-label="Ouvrir le menu" onClick={() => setMenuOpen((open) => !open)}><Menu size={21} /></button>
          <div className="breadcrumb"><span>Atelier</span><ChevronRight size={14} /><strong>{activeView}</strong></div>
          <div className={`connection-chip ${isOnline ? "connected" : "disconnected"}`}><span />{isOnline ? "Stockage local uniquement" : "Hors ligne"}</div>
          <button className="top-avatar" aria-label="Ouvrir les réglages" onClick={() => setActiveView("Réglages")}>AT</button>
        </header>
        <header className={`mobile-topbar ${activeView === "Fiche client" ? "mobile-header-client" : ""}`}>
          {activeView === "Fiche client" ? <>
            <button className="mobile-header-button" aria-label="Retour" onClick={() => setActiveView("Clients")}><ChevronRight className="back-chevron" size={20} /></button>
            <div className="mobile-header-title">Fiche client</div>
            <button className="mobile-header-button" aria-label="Modifier la fiche client" onClick={() => selectedCustomerId && setDialog({ type: "customer", customerId: selectedCustomerId })}><Settings size={17} /></button>
          </> : <>
            <button className="mobile-brand" aria-label="Accueil Toklo" onClick={() => setActiveView("Accueil")}><img src="/toklo.svg" alt="" /><strong>toklo</strong></button>
            <button className="mobile-sync-status" onClick={() => setActiveView("Réglages")}><span />{isOnline ? "Données locales · OK" : "Mode hors ligne"}</button>
          </>}
        </header>
        {error && <div className="error-banner" role="alert"><AlertTriangle size={18} /><span>{error}</span><button aria-label="Fermer" onClick={() => setError("")}><X size={16} /></button></div>}
        <div className="page-content">{renderView()}</div>
      </main>
      <nav className="mobile-nav" aria-label="Navigation mobile">
        {MOBILE_NAV_ITEMS.map(({ title, icon: Icon }) => (
          <button key={title} className={activeView === title || (title === "Clients" && activeView === "Fiche client") ? "active" : ""} onClick={() => {
            setDialog(null);
            setActiveView(title);
            if (title !== "Clients") setSelectedCustomerId("");
            if (title === "Mesures") setDialog({ type: "measurement" });
          }}><Icon size={20} /><span>{title === "Agenda" ? "Rendez-vous" : title}</span></button>
        ))}
      </nav>
      {dialog && (
        <Dialog
          state={dialog}
          data={data}
          customerById={customerById}
          close={() => setDialog(null)}
          save={save}
          saveCustomerAndKeepDialogOpen={saveCustomerAndKeepDialogOpen}
          setToast={setToast}
        />
      )}
      <input ref={importRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => void importBackup(event.target.files?.[0])} />
      {toast && <div className="toast"><Check size={18} />{toast}</div>}
    </div>
  );
}

function Dashboard({
  data,
  appointments,
  activeOrders,
  risks,
  setView,
  openDialog,
  customerById,
}: {
  data: TokloData;
  appointments: Appointment[];
  activeOrders: Order[];
  risks: Order[];
  setView: (view: View) => void;
  openDialog: (dialog: DialogState) => void;
  customerById: (id: string) => Customer | undefined;
}) {
  const totalDue = data.orders.reduce((sum, order) => sum + remainingBalance(order, data.payments), 0);
  const today = dateInputValue();
  const todayAppointments = appointments.filter((item) => item.dateTime.slice(0, 10) === today);
  const dayLabel = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  const firstName = dayLabel;
  const dayAppointments = appointments.slice(0, 4);

  return (
    <div className="page-stack dashboard-page-stack">
      <section className="mobile-home">
        <div className="mobile-intro"><h1>Bonjour</h1><p>{dayLabel}</p></div>
        <div className="mobile-mini-stats">
          <div><strong>{todayAppointments.length}</strong><span>Rendez-vous aujourd'hui</span></div>
          <div><strong>{data.customers.length}</strong><span>Clients enregistrés</span></div>
        </div>
        <button className="measurement-promo" onClick={() => openDialog({ type: "measurement" })}>
          <span className="promo-copy"><small>VOTRE ATELIER, BIEN ORGANISÉ</small><strong>Nouvelle prise<br />de mesures</strong><span>Ouvrez une fiche en 3 touches</span><b>+ Commencer <ChevronRight size={14} /></b></span>
          <span className="promo-illustration"><Shirt size={36} /><span>✦</span></span>
        </button>
        <div className="mobile-section-title"><div><h2>Prochains rendez-vous</h2><p>Votre programme de la journée</p></div><button onClick={() => setView("Agenda")}>Voir tout <ChevronRight size={15} /></button></div>
        <div className="mobile-program">
          {dayAppointments.length ? dayAppointments.map((appointment, index) => <button key={appointment.id} className={`program-card tone-${index % 3}`} onClick={() => setView("Agenda")}><span className="program-time">{new Date(appointment.dateTime).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span><span className="program-details"><strong>{customerName(customerById(appointment.customerId))}</strong><small>{appointment.reason}</small></span><span className="program-tag">{appointment.reason === "Essayage" ? "Essayage" : appointment.reason === "Retrait" ? "Retrait" : "Mesures"}</span></button>) : <button className="program-empty" onClick={() => openDialog({ type: "appointment" })}><CalendarDays size={18} /><span><strong>Aucun rendez-vous prévu</strong><small>Ajouter un rendez-vous</small></span><Plus size={17} /></button>}
        </div>
        <div className="mobile-home-shortcuts"><button onClick={() => openDialog({ type: "order" })}><ClipboardList size={17} /> Nouvelle commande</button><button onClick={() => setView("Finances")}><CircleDollarSign size={17} /> Finances</button></div>
      </section>
      <section className="welcome-row">
        <div><p className="eyebrow">{firstName}</p><h1>Bonjour, atelier <span>👋</span></h1><p className="muted">Voici ce qui se passe dans votre atelier aujourd'hui.</p></div>
        <button className="button button-primary" onClick={() => openDialog({ type: "customer" })}><Plus size={18} /> Nouveau client</button>
      </section>

      {risks.length > 0 && (
        <button className="alert-strip" onClick={() => setView("Commandes")}>
          <span className="alert-icon"><AlertTriangle size={19} /></span>
          <span><strong>{risks.length} commande{risks.length > 1 ? "s" : ""} à surveiller</strong><small>Une livraison approche ou est en retard. Vérifiez votre suivi.</small></span>
          <ChevronRight className="alert-arrow" size={19} />
        </button>
      )}

      <section className="stats-grid">
        <StatCard label="Mes clients" value={String(data.customers.length)} detail="Clients enregistrés" icon={<UsersRound size={20} />} color="sage" />
        <StatCard label="Commandes en cours" value={String(activeOrders.length)} detail={`${risks.length} à surveiller`} icon={<ClipboardList size={20} />} color="orange" />
        <StatCard label="Rendez-vous aujourd'hui" value={String(todayAppointments.length)} detail="Dans votre agenda" icon={<CalendarDays size={20} />} color="blue" />
        <StatCard label="Reste à encaisser" value={formatMoney(totalDue)} detail="Sur toutes les commandes" icon={<CircleDollarSign size={20} />} color="lavender" />
      </section>

      <section className="quick-actions">
        <button className="quick-action" onClick={() => openDialog({ type: "customer" })}><span className="quick-icon peach"><UserRound size={20} /></span><span><strong>Ajouter un client</strong><small>Créer une fiche</small></span><Plus size={18} /></button>
        <button className="quick-action" onClick={() => openDialog({ type: "measurement" })}><span className="quick-icon green"><Shirt size={20} /></span><span><strong>Prendre des mesures</strong><small>Nouvelle fiche</small></span><Plus size={18} /></button>
        <button className="quick-action" onClick={() => openDialog({ type: "order" })}><span className="quick-icon blue-soft"><ClipboardList size={20} /></span><span><strong>Créer une commande</strong><small>Suivre un vêtement</small></span><Plus size={18} /></button>
      </section>

      <section className="dashboard-columns">
        <div className="panel">
          <div className="panel-heading"><div><h2>Prochains rendez-vous</h2><p>Vos essayages et rendez-vous à venir</p></div><button className="text-button" onClick={() => setView("Agenda")}>Tout voir <ChevronRight size={15} /></button></div>
          {appointments.length ? <div className="appointment-list">
            {appointments.slice(0, 4).map((appointment) => (
              <div className="appointment-row" key={appointment.id}>
                <div className="date-tile"><strong>{new Date(appointment.dateTime).toLocaleDateString("fr-FR", { day: "2-digit" })}</strong><small>{new Date(appointment.dateTime).toLocaleDateString("fr-FR", { month: "short" }).replace(".", "")}</small></div>
                <div className="appointment-info"><strong>{customerName(customerById(appointment.customerId))}</strong><small>{appointment.reason}</small></div>
                <span className="appointment-time"><Clock3 size={14} />{new Date(appointment.dateTime).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            ))}
          </div> : <EmptyState icon={<CalendarDays size={21} />} title="Rien de prévu pour le moment" action="Ajouter un rendez-vous" onClick={() => openDialog({ type: "appointment" })} />}
        </div>
        <div className="panel">
          <div className="panel-heading"><div><h2>Commandes récentes</h2><p>Gardez le fil de vos créations</p></div><button className="text-button" onClick={() => setView("Commandes")}>Tout voir <ChevronRight size={15} /></button></div>
          {data.orders.length ? <div className="recent-orders">
            {[...data.orders].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4).map((order) => (
              <div className="recent-order-row" key={order.id}>
                <div className="order-mini-icon"><Shirt size={17} /></div>
                <div className="recent-order-info"><strong>{customerName(customerById(order.customerId))}</strong><small>{order.garment} · {order.reference}</small></div>
                <StatusBadge status={order.status} />
              </div>
            ))}
          </div> : <EmptyState icon={<ClipboardList size={21} />} title="Vos commandes apparaîtront ici" action="Créer une commande" onClick={() => openDialog({ type: "order" })} />}
        </div>
      </section>
      <p className="privacy-note"><Cloud size={15} /> Vos données sont enregistrées sur cet appareil. Exportez régulièrement une copie dans Réglages.</p>
    </div>
  );
}

function StatCard({ label, value, detail, icon, color }: { label: string; value: string; detail: string; icon: ReactNode; color: string }) {
  return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${color}`}>{icon}</span></div><strong className="stat-value">{value}</strong><small>{detail}</small></div>;
}

function CustomersPage({
  customers,
  allCustomers,
  query,
  setQuery,
  openDialog,
  measurements,
  orders,
  appointments,
  onOpenCustomer,
}: {
  customers: Customer[];
  allCustomers: Customer[];
  query: string;
  setQuery: (value: string) => void;
  openDialog: (dialog: DialogState) => void;
  measurements: Measurement[];
  orders: Order[];
  appointments: Appointment[];
  onOpenCustomer: (id: string) => void;
}) {
  return (
    <div className="page-stack">
      <PageTitle title="Vos clients" subtitle="Retrouvez les fiches et l'historique de votre clientèle." action={<button className="button button-primary" onClick={() => openDialog({ type: "customer" })}><Plus size={18} /> Nouveau client</button>} />
      <div className="toolbar"><div className="search-field"><Search size={18} /><input placeholder="Rechercher par nom, numéro ou code…" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>⌘ K</kbd></div><span className="result-count">{customers.length} client{customers.length !== 1 ? "s" : ""}</span></div>
      {customers.length ? <div className="customer-grid">
        {customers.map((customer) => {
          const customerMeasurements = measurements.filter((item) => item.customerId === customer.id);
          const customerOrders = orders.filter((item) => item.customerId === customer.id && !item.deletedAt);
          const customerAppointments = appointments.filter((item) => item.customerId === customer.id && item.status === "Prévu");
          return (
            <article className="customer-card" key={customer.id}>
              <div className="customer-card-top"><div className="customer-avatar">{customer.firstName[0]?.toUpperCase()}{customer.lastName[0]?.toUpperCase()}</div><span className="code-chip">{customer.code}</span></div>
              <button className="customer-name-button" onClick={() => onOpenCustomer(customer.id)}><h3>{customerName(customer)}</h3><ChevronRight size={14} /></button><p className="customer-phone">{customer.phone}</p>
              <div className="customer-tags"><span>{customer.category}</span>{customer.neighborhood && <span>{customer.neighborhood}</span>}</div>
              <div className="customer-summary"><span><Shirt size={14} /> {customerMeasurements.length} mesures</span><span><ClipboardList size={14} /> {customerOrders.length} commandes</span></div>
              <div className="customer-actions">
                <button onClick={() => openDialog({ type: "measurement", customerId: customer.id })}>Mesures</button>
                <button onClick={() => openDialog({ type: "order", customerId: customer.id })}>Commande</button>
                <button className="icon-button" aria-label={`Modifier ${customerName(customer)}`} onClick={() => openDialog({ type: "customer", customerId: customer.id })}><MoreHorizontal size={19} /></button>
              </div>
              {customerAppointments.length > 0 && <div className="customer-upcoming"><CalendarDays size={14} /> Prochain rendez-vous {readableDateTime(customerAppointments[0].dateTime)}</div>}
            </article>
          );
        })}
      </div> : <EmptyPanel title={allCustomers.length ? "Aucun résultat" : "Votre premier client vous attend"} text={allCustomers.length ? "Essayez un autre nom ou numéro." : "Créez une fiche pour garder ses coordonnées et ses mesures."} action={allCustomers.length ? undefined : "Ajouter un client"} onClick={allCustomers.length ? undefined : () => openDialog({ type: "customer" })} />}
    </div>
  );
}

function CustomerDetailPage({
  customer,
  data,
  openDialog,
  save,
  onBack,
}: {
  customer?: Customer;
  data: TokloData;
  openDialog: (dialog: DialogState) => void;
  save: <T extends TableName,>(table: T, record: TokloData[T][number]) => Promise<void>;
  onBack: () => void;
}) {
  if (!customer) return <EmptyPanel title="Cette fiche n'est plus disponible" text="Le client a peut-être été archivé." action="Retour aux clients" onClick={onBack} />;
  const measurements = data.measurements.filter((item) => item.customerId === customer.id).sort((a, b) => b.date.localeCompare(a.date));
  const orders = data.orders.filter((item) => item.customerId === customer.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const appointments = data.appointments.filter((item) => item.customerId === customer.id && item.status === "Prévu").sort((a, b) => a.dateTime.localeCompare(b.dateTime));
  const latestByGarment = [...new Set(measurements.map((item) => item.garment))].slice(0, 3).map((garment) => measurements.find((item) => item.garment === garment)!);
  return <div className="page-stack customer-detail-page">
    <PageTitle title={customerName(customer)} subtitle={`${customer.phone}${customer.neighborhood ? ` · ${customer.neighborhood}` : ""}`} action={<button className="button button-outline" onClick={() => {
      if (window.confirm(`Archiver la fiche de ${customerName(customer)} ?`)) void save("customers", { ...customer, deletedAt: nowIso(), updatedAt: nowIso() }).then(onBack);
    }}>Archiver</button>} />
    <section className="mobile-client-hero"><div className="large-customer-avatar">{customer.firstName[0]?.toUpperCase()}{customer.lastName[0]?.toUpperCase()}</div><div><strong>{customerName(customer)}</strong><span>{customer.phone}</span><small>{customer.category}{customer.neighborhood ? ` · ${customer.neighborhood}` : ""}</small></div><span className="code-chip">{customer.code}</span></section>
    <section className="mobile-measure-summary"><div className="mobile-section-title"><div><h2>Dernières mesures</h2><p>Votre historique reste conservé</p></div><button onClick={() => openDialog({ type: "measurement", customerId: customer.id })}>+ Nouvelle</button></div>
      {latestByGarment.length ? <div className="measure-summary-cards">{latestByGarment.map((measurement) => {
        const key = Object.keys(measurement.values).find((field) => field.toLocaleLowerCase("fr").includes("poitrine")) ?? Object.keys(measurement.values)[0];
        return <button key={measurement.id} onClick={() => openDialog({ type: "measurement", customerId: customer.id })}><span>{key ?? measurement.garment}</span><strong>{measurement.values[key] ?? "—"} <small>{measurement.unit}</small></strong><small>{measurement.garment}</small></button>;
      })}</div> : <div className="client-empty-card"><Shirt size={17} /><span>Aucune mesure enregistrée</span><button onClick={() => openDialog({ type: "measurement", customerId: customer.id })}>Prendre les mesures</button></div>}
    </section>
    <section className="mobile-client-history"><div className="mobile-section-title"><div><h2>Historique</h2><p>Mesures et commandes</p></div><button onClick={() => openDialog({ type: "order", customerId: customer.id })}>+ Commande</button></div>
      {[...measurements.slice(0, 4).map((item) => ({ id: item.id, label: item.garment, detail: `Mesure le ${readableDate(item.date)}`, icon: <Shirt size={17} />, action: () => openDialog({ type: "measurement", customerId: customer.id }) })), ...orders.slice(0, 3).map((item) => ({ id: item.id, label: item.garment, detail: `${item.reference} · ${item.status}`, icon: <ClipboardList size={17} />, action: () => openDialog({ type: "order", customerId: customer.id }) }))].map((item) => <button className="client-history-row" key={item.id} onClick={item.action}><span className="history-icon">{item.icon}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span><ChevronRight size={16} /></button>)}
      {!measurements.length && !orders.length && <p className="empty-history">Les mesures et commandes s'afficheront ici.</p>}
    </section>
    {appointments[0] && <button className="client-next-appointment" onClick={() => openDialog({ type: "appointment", customerId: customer.id })}><CalendarDays size={18} /><span><strong>Prochain rendez-vous</strong><small>{appointments[0].reason} · {readableDateTime(appointments[0].dateTime)}</small></span><ChevronRight size={16} /></button>}
    {!appointments.length && <button className="client-next-appointment" onClick={() => openDialog({ type: "appointment", customerId: customer.id })}><CalendarDays size={18} /><span><strong>Ajouter un rendez-vous</strong><small>Mesure, essayage ou retrait</small></span><Plus size={17} /></button>}
    <div className="mobile-client-actions"><button onClick={() => openDialog({ type: "measurement", customerId: customer.id })}><Shirt size={17} /> Mesures</button><button onClick={() => openDialog({ type: "order", customerId: customer.id })}><Plus size={17} /> Commande</button><button onClick={() => openDialog({ type: "appointment", customerId: customer.id })}><CalendarDays size={17} /> Rendez-vous</button></div>
  </div>;
}

function MeasurementsPage({ data, customerById, openDialog }: { data: TokloData; customerById: (id: string) => Customer | undefined; openDialog: (dialog: DialogState) => void }) {
  const [customerFilter, setCustomerFilter] = useState("");
  const filtered = data.measurements.filter((measurement) => !customerFilter || measurement.customerId === customerFilter);
  const ordered = [...filtered].sort((a, b) => b.date.localeCompare(a.date));
  return <div className="page-stack">
    <PageTitle title="Carnet de mesures" subtitle="Chaque nouvelle prise est conservée dans l'historique." action={<button className="button button-primary" onClick={() => openDialog({ type: "measurement", customerId: customerFilter || undefined })}><Plus size={18} /> Nouvelle prise</button>} />
    <div className="toolbar"><label className="select-field"><UsersRound size={17} /><select value={customerFilter} onChange={(event) => setCustomerFilter(event.target.value)}><option value="">Tous les clients</option>{data.customers.map((customer) => <option key={customer.id} value={customer.id}>{customerName(customer)}</option>)}</select><ChevronDown size={16} /></label><span className="result-count">{ordered.length} fiche{ordered.length === 1 ? "" : "s"}</span></div>
    {ordered.length ? <div className="panel measurements-table-wrap"><table className="data-table"><thead><tr><th>CLIENT</th><th>VÊTEMENT</th><th>MESURES</th><th>PRISE LE</th><th>UNITÉ</th><th></th></tr></thead><tbody>
      {ordered.map((measurement) => <tr key={measurement.id}><td><div className="table-person"><div className="small-avatar">{customerById(measurement.customerId)?.firstName[0] ?? "?"}</div><span><strong>{customerName(customerById(measurement.customerId))}</strong><small>{customerById(measurement.customerId)?.phone}</small></span></div></td><td><span className="garment-chip"><Shirt size={14} />{measurement.garment}</span></td><td className="measurement-preview">{Object.entries(measurement.values).filter(([, value]) => value).slice(0, 3).map(([key, value]) => `${key} ${value}`).join(" · ") || "Aucune valeur"}</td><td>{readableDate(measurement.date)}</td><td>{measurement.unit}</td><td><button className="icon-button" title="Imprimer cette fiche" onClick={() => printMeasurement(measurement, customerById(measurement.customerId))}><Printer size={17} /></button></td></tr>)}
    </tbody></table></div> : <EmptyPanel title="Aucune mesure enregistrée" text="Choisissez un client et créez la première fiche de mesures." action="Prendre des mesures" onClick={() => openDialog({ type: "measurement", customerId: customerFilter || undefined })} />}
  </div>;
}

function OrdersPage({ data, customerById, openDialog, save }: { data: TokloData; customerById: (id: string) => Customer | undefined; openDialog: (dialog: DialogState) => void; save: <T extends TableName,>(table: T, record: TokloData[T][number]) => Promise<void> }) {
  const [filter, setFilter] = useState<"Toutes" | OrderStatus>("Toutes");
  const shown = [...data.orders].filter((order) => filter === "Toutes" || order.status === filter).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <div className="page-stack">
    <PageTitle title="Suivi des commandes" subtitle="Suivez chaque vêtement, de la coupe à la livraison." action={<button className="button button-primary" onClick={() => openDialog({ type: "order" })}><Plus size={18} /> Nouvelle commande</button>} />
    <div className="status-filters"><button className={filter === "Toutes" ? "selected" : ""} onClick={() => setFilter("Toutes")}>Toutes <span>{data.orders.length}</span></button>{ORDER_STATUSES.map((status) => <button key={status} className={filter === status ? "selected" : ""} onClick={() => setFilter(status)}>{status}</button>)}</div>
    <div className="orders-list">
      {shown.length ? shown.map((order) => {
        const risk = orderRisk(order);
        return <article className="order-card" key={order.id}>
          <div className="order-card-image">{order.photos?.[0] ? <img src={order.photos[0]} alt={`Photo du modèle ${order.garment}`} /> : <Shirt size={26} />}<small>{order.garment}</small></div>
          <div className="order-main"><div className="order-title-row"><span className="order-reference">{order.reference}</span><StatusBadge status={order.status} />{risk && <span className={`risk-badge ${risk}`}>{risk === "late" ? "En retard" : "À risque"}</span>}</div><h3>{customerName(customerById(order.customerId))}</h3><p>{order.garment}{order.model ? ` · ${order.model}` : ""}</p><div className="order-meta"><span><CalendarDays size={14} /> Livraison {readableDate(order.dueDate)}</span><span><CircleDollarSign size={14} /> Reste {formatMoney(remainingBalance(order, data.payments))}</span></div></div>
          <div className="order-controls"><label>État de confection<select value={order.status} onChange={(event) => {
            const status = event.target.value as OrderStatus;
            if (!allowedNextStatuses(order.status).includes(status)) {
              window.alert("Cette étape ne suit pas le statut actuel de la commande.");
              return;
            }
            if (status === "Livré" && !window.confirm("Confirmer que le vêtement a été remis au client ?")) return;
            if (status === "Annulé" && !window.confirm("Confirmer l'annulation de cette commande ?")) return;
            void save("orders", { ...order, status, updatedAt: nowIso(), statusHistory: [...order.statusHistory, { status, date: nowIso() }] });
          }}>{[order.status, ...allowedNextStatuses(order.status)].map((status) => <option key={status}>{status}</option>)}</select></label>
            <div className="order-action-row"><button className="button button-outline button-small" onClick={() => openDialog({ type: "payment", orderId: order.id })}><Plus size={15} /> Paiement</button><button className="icon-button" title="Reçu" onClick={() => openDialog({ type: "receipt", orderId: order.id })}><FileText size={17} /></button></div>
          </div>
        </article>;
      }) : <EmptyPanel title="Aucune commande ici" text="Les commandes créées s'afficheront dans ce suivi." action="Créer une commande" onClick={() => openDialog({ type: "order" })} />}
    </div>
  </div>;
}

function AgendaPage({ data, customerById, openDialog, save }: { data: TokloData; customerById: (id: string) => Customer | undefined; openDialog: (dialog: DialogState) => void; save: <T extends TableName,>(table: T, record: TokloData[T][number]) => Promise<void> }) {
  const [selectedDay, setSelectedDay] = useState(dateInputValue());
  const days = dateStrip();
  const entries = [
    ...data.appointments.filter((item) => item.status !== "Annulé").map((item) => ({ id: item.id, date: item.dateTime, type: "appointment" as const, item })),
    ...data.orders.filter((item) => item.fittingDate && !["Livré", "Annulé"].includes(item.status)).map((item) => ({ id: `${item.id}-fitting`, date: `${item.fittingDate}T12:00:00`, type: "fitting" as const, item })),
    ...data.orders.filter((item) => item.dueDate && !["Livré", "Annulé"].includes(item.status)).map((item) => ({ id: `${item.id}-due`, date: `${item.dueDate}T16:00:00`, type: "delivery" as const, item })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const dayEntries = entries.filter((entry) => entry.date.slice(0, 10) === selectedDay);
  return <div className="page-stack agenda-page-stack">
    <PageTitle title="Rendez-vous" subtitle="Essayages, mesures et retraits à venir." action={<button className="button button-primary" onClick={() => openDialog({ type: "appointment" })}><Plus size={18} /> Nouveau rendez-vous</button>} />
    <div className="mobile-agenda-head"><strong>{selectedDay === dateInputValue() ? "Aujourd'hui" : readableDate(selectedDay)}</strong><span>{dayEntries.length} rendez-vous ou échéance{dayEntries.length === 1 ? "" : "s"}</span></div>
    <div className="day-strip agenda-day-strip" aria-label="Choisir une date">
      {days.map((day) => {
        const date = new Date(`${day}T12:00:00`);
        return <button key={day} className={selectedDay === day ? "selected" : ""} onClick={() => setSelectedDay(day)}><span>{new Intl.DateTimeFormat("fr-FR", { weekday: "short" }).format(date).replace(".", "")}</span><strong>{date.getDate()}</strong></button>;
      })}
    </div>
    <div className="agenda-note"><CalendarDays size={18} /><span>Les rappels sont affichés dans l'application. Autorisez les notifications de Toklo dans votre navigateur pour être averti.</span></div>
    {dayEntries.length ? <div className="agenda-list">{dayEntries.map((entry, index) => {
      const customerId = entry.type === "appointment" ? entry.item.customerId : entry.item.customerId;
      const date = new Date(entry.date);
      const label = entry.type === "appointment" ? entry.item.reason : entry.type === "fitting" ? "Essayage" : "Livraison promise";
      const details = entry.type === "appointment" ? entry.item.notes : entry.item.garment;
      return <div className="agenda-row" key={entry.id}><div className="agenda-date"><strong>{date.toLocaleDateString("fr-FR", { day: "2-digit" })}</strong><span>{date.toLocaleDateString("fr-FR", { month: "short" })}</span></div><div className="agenda-rail"><i /></div><div className={`agenda-card tone-${index % 3}`}><div><span className={`agenda-kind ${entry.type}`}>{label}</span><h3>{customerName(customerById(customerId))}</h3><p>{details}</p></div><div className="agenda-actions"><span>{readableDateTime(entry.date)}</span>{entry.type === "appointment" && entry.item.status === "Prévu" && <button className="button button-outline button-small" onClick={() => void save("appointments", { ...entry.item, status: "Fait", updatedAt: nowIso() })}><Check size={15} /> Fait</button>}</div></div></div>;
    })}</div> : <EmptyPanel title="Aucun rendez-vous prévu" text={selectedDay === dateInputValue() ? "Profitez-en pour prendre de l'avance sur votre atelier." : "Aucune activité planifiée pour cette date."} />}
    <button className="agenda-add-cta" onClick={() => openDialog({ type: "appointment" })}><Plus size={16} /> Ajouter un rendez-vous</button>
  </div>;
}

function FinancePage({ data, customerById, openDialog }: { data: TokloData; customerById: (id: string) => Customer | undefined; openDialog: (dialog: DialogState) => void }) {
  const total = data.orders.reduce((sum, order) => sum + order.totalPrice, 0);
  const paid = data.payments.reduce((sum, payment) => sum + payment.amount, 0);
  const balance = data.orders.reduce((sum, order) => sum + remainingBalance(order, data.payments), 0);
  const owing = data.orders.filter((order) => remainingBalance(order, data.payments) > 0);
  return <div className="page-stack">
    <PageTitle title="Finances" subtitle="Les paiements sont saisis manuellement. Toklo ne réalise aucun encaissement." />
    <section className="finance-stats"><StatCard label="Prix total des commandes" value={formatMoney(total)} detail="Toutes les commandes" icon={<ClipboardList size={20} />} color="sage" /><StatCard label="Déjà encaissé" value={formatMoney(paid)} detail={`${data.payments.length} paiement${data.payments.length !== 1 ? "s" : ""}`} icon={<Check size={20} />} color="green" /><StatCard label="Reste à encaisser" value={formatMoney(balance)} detail={`${owing.length} commande${owing.length !== 1 ? "s" : ""} concernée${owing.length !== 1 ? "s" : ""}`} icon={<CircleDollarSign size={20} />} color="orange" /></section>
    <div className="panel">
      <div className="panel-heading"><div><h2>Soldes à encaisser</h2><p>Les avances restent liées à leur commande.</p></div></div>
      {owing.length ? <div className="finance-list">{owing.map((order) => <div className="finance-row" key={order.id}><div className="finance-person-avatar">{customerById(order.customerId)?.firstName[0] ?? "?"}</div><div className="finance-person"><strong>{customerName(customerById(order.customerId))}</strong><small>{order.reference} · {order.garment} · Total {formatMoney(order.totalPrice)}</small></div><div className="finance-amount"><strong>{formatMoney(remainingBalance(order, data.payments))}</strong><small>à recevoir</small></div><button className="button button-outline button-small" onClick={() => openDialog({ type: "payment", orderId: order.id })}><Plus size={15} /> Ajouter</button><button className="icon-button" aria-label="Ouvrir le reçu" onClick={() => openDialog({ type: "receipt", orderId: order.id })}><FileText size={17} /></button></div>)}</div> : <EmptyState icon={<Check size={21} />} title="Tous les paiements sont à jour" />}
    </div>
    {data.payments.length > 0 && <div className="panel"><div className="panel-heading"><div><h2>Derniers paiements</h2><p>Historique des encaissements notés.</p></div></div><div className="payment-history">{[...data.payments].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8).map((payment) => {
      const order = data.orders.find((item) => item.id === payment.orderId);
      return <div className="payment-history-row" key={payment.id}><div className="payment-check"><Check size={16} /></div><div><strong>{customerName(customerById(order?.customerId ?? ""))}</strong><small>{payment.channel} · {readableDate(payment.date)} · {order?.reference ?? "Commande archivée"}</small></div><b>+ {formatMoney(payment.amount)}</b></div>;
    })}</div></div>}
  </div>;
}

function SettingsPage({ storagePersistent, exportCsv, exportJson, onImport }: { storagePersistent: boolean | null; exportCsv: () => void; exportJson: () => void; onImport: () => void }) {
  return <div className="page-stack">
    <PageTitle title="Réglages" subtitle="Préservez vos données et adaptez Toklo à votre atelier." />
    <div className="settings-grid">
      <section className="panel settings-panel"><div className="settings-heading"><span className="settings-icon green"><ArrowDownToLine size={20} /></span><div><h2>Sauvegarde et export</h2><p>Les données restent sur ce téléphone. Gardez une copie personnelle.</p></div></div>
        <div className="storage-status"><span className={`storage-dot ${storagePersistent ? "ok" : ""}`} /><span><strong>{storagePersistent ? "Stockage protégé" : storagePersistent === false ? "Stockage du navigateur" : "Vérification du stockage…"}</strong><small>{storagePersistent ? "Le navigateur a accordé le stockage persistant." : "Exportez régulièrement une copie pour éviter toute perte."}</small></span></div>
        <div className="settings-buttons"><button className="button button-primary" onClick={exportJson}><Download size={17} /> Télécharger une sauvegarde</button><button className="button button-outline" onClick={onImport}><ArrowDownToLine size={17} /> Restaurer une sauvegarde</button><button className="button button-outline" onClick={exportCsv}><FileText size={17} /> Exporter en CSV</button></div>
      </section>
      <section className="panel settings-panel"><div className="settings-heading"><span className="settings-icon peach"><Headphones size={20} /></span><div><h2>Langue et accessibilité</h2><p>Interface en français. Les documents clients restent en français.</p></div></div>
        <div className="settings-row"><div><strong>Guide audio</strong><small>Lecture vocale des libellés (si disponible sur l'appareil)</small></div><button className="button button-outline button-small" onClick={() => speak("Bienvenue dans Toklo, votre assistant d'atelier.")}><Headphones size={15} /> Tester</button></div>
        <div className="settings-row"><div><strong>Unité de mesure par défaut</strong><small>Vous pouvez la modifier à chaque nouvelle fiche.</small></div><span className="preference-chip">Centimètres</span></div>
      </section>
      <section className="panel settings-panel settings-wide"><div className="settings-heading"><span className="settings-icon blue-soft"><Cloud size={20} /></span><div><h2>Compte et synchronisation</h2><p>Cette version enregistre les données localement et fonctionne hors ligne.</p></div></div><div className="coming-soon"><AlertTriangle size={17} /><span><strong>Connexion et sauvegarde en ligne non configurées.</strong> Pour protéger vos données sur plusieurs appareils, un projet Firebase et ses règles d'accès doivent être ajoutés avant le déploiement.</span></div></section>
      <section className="panel settings-panel settings-wide"><div className="settings-heading"><span className="settings-icon lavender"><ShieldCheck size={20} /></span><div><h2>Confidentialité</h2><p>Toklo ne transmet pas les fiches clients vers un serveur dans cette version.</p></div></div><p className="privacy-copy">Les photos et les coordonnées sont des données personnelles. Obtenez toujours le consentement avant de prendre ou conserver une photo, protégez l'accès à votre téléphone et utilisez l'export/suppression selon la demande du client.</p></section>
    </div>
  </div>;
}

function PageTitle({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-title-row"><div><p className="eyebrow">MON ATELIER</p><h1>{title}</h1><p className="muted">{subtitle}</p></div>{action}</div>;
}

function EmptyState({ icon, title, action, onClick }: { icon: ReactNode; title: string; action?: string; onClick?: () => void }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><strong>{title}</strong>{action && onClick && <button className="text-button" onClick={onClick}>{action} <ChevronRight size={15} /></button>}</div>;
}

function EmptyPanel({ title, text, action, onClick }: { title: string; text: string; action?: string; onClick?: () => void }) {
  return <div className="panel empty-panel"><span className="empty-icon"><FileText size={22} /></span><h3>{title}</h3><p>{text}</p>{action && onClick && <button className="button button-primary" onClick={onClick}><Plus size={17} />{action}</button>}</div>;
}

function StatusBadge({ status }: { status: OrderStatus }) {
  const kind = status === "Livré" || status === "Terminé" ? "success" : status === "Annulé" ? "neutral" : status === "Retouches" ? "warning" : "progress";
  return <span className={`status-badge ${kind}`}><i />{status}</span>;
}

function Dialog({
  state,
  data,
  customerById,
  close,
  save,
  saveCustomerAndKeepDialogOpen,
  setToast,
}: {
  state: DialogState;
  data: TokloData;
  customerById: (id: string) => Customer | undefined;
  close: () => void;
  save: <T extends TableName,>(table: T, record: TokloData[T][number]) => Promise<void>;
  saveCustomerAndKeepDialogOpen: (customer: Customer) => Promise<void>;
  setToast: (message: string) => void;
}) {
  const [garment, setGarment] = useState<Garment>("Robe");
  const [customField, setCustomField] = useState("");
  const [unit, setUnit] = useState<"cm" | "in">("cm");
  const [measurementValues, setMeasurementValues] = useState<Record<string, string>>({});
  const [measurementCustomerId] = useState("customerId" in state ? state.customerId ?? "" : "");
  const [measurementName, setMeasurementName] = useState("");
  const [measurementPhone, setMeasurementPhone] = useState("");
  const [showAllMeasurements, setShowAllMeasurements] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [voiceNote, setVoiceNote] = useState("");
  const [recording, setRecording] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", handleKey);
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", handleKey);
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [close]);

  const toggleRecording = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        if (audio.size > 1_000_000) {
          setMediaError("La note vocale dépasse 1 Mo. Enregistrez une note plus courte.");
          return;
        }
        void fileAsDataUrl(audio).then(setVoiceNote).catch((cause: unknown) => {
          console.error("Impossible de sauvegarder la note vocale.", cause);
          setMediaError("La note vocale n'a pas pu être sauvegardée.");
        });
      };
      recorderRef.current = recorder;
      recorder.start();
      setMediaError("");
      setRecording(true);
    } catch (cause) {
      console.error("Accès au microphone refusé ou indisponible.", cause);
      setMediaError("Autorisez le microphone dans votre navigateur pour enregistrer une note vocale.");
    }
  };

  const customerOptions = state.type === "payment" || state.type === "receipt" ? [] : data.customers;
  const initialCustomerId = "customerId" in state ? state.customerId : undefined;
  const selectedCustomer = state.type === "measurement" ? customerById(measurementCustomerId) : undefined;
  useEffect(() => {
    if (state.type !== "measurement" || !measurementCustomerId) return;
    const customer = data.customers.find((item) => item.id === measurementCustomerId);
    if (customer) {
      setMeasurementName(customerName(customer));
      setMeasurementPhone(customer.phone);
    }
  }, [measurementCustomerId, data.customers, state.type]);
  const title = {
    customer: state.type === "customer" && state.customerId ? "Modifier la fiche client" : "Nouveau client",
    measurement: "Nouvelle mesure",
    order: "Nouvelle commande",
    appointment: "Nouveau rendez-vous",
    payment: "Ajouter un paiement",
    receipt: "Reçu de commande",
  }[state.type];

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const timestamp = nowIso();
    if (state.type === "customer") {
      const existing = state.customerId ? data.customers.find((item) => item.id === state.customerId) : undefined;
      const firstName = String(form.get("firstName") ?? "").trim();
      const lastName = String(form.get("lastName") ?? "").trim();
      const phone = String(form.get("phone") ?? "").trim();
      const similar = data.customers.find((item) => item.id !== existing?.id && item.phone.replace(/\D/g, "") === phone.replace(/\D/g, ""));
      if (similar && !window.confirm(`Ce numéro est déjà associé à ${customerName(similar)}. Enregistrer quand même ?`)) return;
      const record: Customer = {
        ...baseRecord(),
        ...(existing ?? {}),
        id: existing?.id ?? createId(),
        code: existing?.code ?? customerCode(data.customers.length + 1),
        firstName,
        lastName,
        phone,
        category: String(form.get("category") ?? "Femme") as Category,
        neighborhood: String(form.get("neighborhood") ?? "").trim(),
        notes: String(form.get("notes") ?? "").trim(),
        photoConsent: form.get("photoConsent") === "on",
        updatedAt: timestamp,
      };
      await save("customers", record);
      return;
    }
    if (state.type === "measurement") {
      const values = { ...measurementValues };
      const name = String(form.get("customField") ?? "").trim();
      const value = String(form.get("customValue") ?? "").trim();
      if (name && value) values[name] = value;
      if (Object.values(values).every((item) => !item)) {
        setToast("Saisissez au moins une mesure");
        return;
      }
      const fullName = String(form.get("customerName") ?? "").trim().replace(/\s+/g, " ");
      const phone = String(form.get("customerPhone") ?? "").trim();
      if (!fullName || !phone) {
        setToast("Renseignez le nom et le téléphone du client");
        return;
      }
      let customerId = measurementCustomerId;
      if (!customerId) {
        const normalizedPhone = phone.replace(/\D/g, "");
        const existing = data.customers.find((item) => item.phone.replace(/\D/g, "") === normalizedPhone);
        if (existing) {
          customerId = existing.id;
        } else {
          const [firstName, ...lastParts] = fullName.split(" ");
          const newCustomer: Customer = {
            ...baseRecord(),
            code: customerCode(data.customers.length + 1),
            firstName,
            lastName: lastParts.join(" "),
            phone,
            category: "Femme",
            neighborhood: "",
            notes: "",
            photoConsent: false,
          };
          try {
            await saveCustomerAndKeepDialogOpen(newCustomer);
            customerId = newCustomer.id;
          } catch (cause) {
            console.error("Impossible de créer le client depuis la fiche de mesures.", cause);
            setToast("Le client n'a pas pu être enregistré. Réessayez.");
            return;
          }
        }
      }
      const record: Measurement = {
        ...baseRecord(), customerId, garment, date: dateInputValue(),
        returnDate: String(form.get("returnDate") ?? "") || undefined,
        unit, values, notes: String(form.get("notes") ?? "").trim(), author: "Atelier",
      };
      await save("measurements", record);
      return;
    }
    if (state.type === "order") {
      const customerId = String(form.get("customerId") ?? "");
      const totalPrice = Number(form.get("totalPrice"));
      const dueDate = String(form.get("dueDate") ?? "");
      const fittingDate = String(form.get("fittingDate") ?? "");
      const advance = Number(form.get("advance") ?? 0);
      if (!Number.isFinite(totalPrice) || totalPrice < 0 || !Number.isFinite(advance) || advance < 0 || advance > totalPrice) {
        setToast("L'avance doit être comprise entre 0 et le prix total");
        return;
      }
      const status: OrderStatus = "Brouillon";
      const count = data.orders.length + 1;
      const record: Order = {
        ...baseRecord(), reference: `CMD-${String(count).padStart(4, "0")}`, customerId, garment,
        model: String(form.get("model") ?? "").trim(), status, fittingDate, dueDate, totalPrice,
        notes: String(form.get("notes") ?? "").trim(), photos, voiceNote: voiceNote || undefined,
        statusHistory: [{ status, date: timestamp }],
      };
      await save("orders", record);
      if (advance > 0) {
        const payment: Payment = { ...baseRecord(), orderId: record.id, amount: advance, channel: String(form.get("channel") ?? "Espèces") as PaymentChannel, date: dateInputValue() };
        await save("payments", payment);
      }
      return;
    }
    if (state.type === "appointment") {
      const customerId = String(form.get("customerId") ?? "");
      const date = String(form.get("date") ?? "");
      const time = String(form.get("time") ?? "");
      const record: Appointment = { ...baseRecord(), customerId, dateTime: new Date(`${date}T${time}`).toISOString(), reason: String(form.get("reason") ?? "Essayage") as AppointmentReason, status: "Prévu", notes: String(form.get("notes") ?? "").trim() };
      await save("appointments", record);
      return;
    }
    if (state.type === "payment") {
      const order = data.orders.find((item) => item.id === state.orderId);
      if (!order) return;
      const amount = Number(form.get("amount"));
      const balance = remainingBalance(order, data.payments);
      if (!paymentIsValid(amount, balance)) {
        setToast("Le montant doit être positif et ne pas dépasser le reste à payer");
        return;
      }
      const record: Payment = { ...baseRecord(), orderId: order.id, amount, channel: String(form.get("channel") ?? "Espèces") as PaymentChannel, date: dateInputValue() };
      await save("payments", record);
    }
  };

  const orderForDialog = state.type === "payment" || state.type === "receipt" ? data.orders.find((item) => item.id === state.orderId) : undefined;
  if (state.type === "receipt") return <ReceiptDialog order={orderForDialog} data={data} customerById={customerById} close={close} />;

  const existingCustomer = state.type === "customer" && state.customerId ? data.customers.find((item) => item.id === state.customerId) : undefined;
  const orderBalance = state.type === "payment" && orderForDialog ? remainingBalance(orderForDialog, data.payments) : 0;
  const fields = state.type === "measurement" ? [...MEASUREMENT_FIELDS[garment], ...(garment === "Autre" ? ["Nom de la mesure"] : [])] : [];
  const primaryRobeFields = ["Tour de poitrine", "Tour de taille", "Tour de bassin", "Épaule", "Longueur de manche", "Longueur de la robe"];
  const visibleFields = garment === "Robe" && !showAllMeasurements ? primaryRobeFields : fields;

  return <div className={`modal-backdrop ${state.type === "measurement" ? "measurement-page-backdrop" : ""}`} onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabIndex={-1} ref={dialogRef}>
      {state.type === "measurement" ? <div className="dialog-header measurement-dialog-header"><button className="measurement-back-button" aria-label="Retour" onClick={close}><ChevronRight size={20} /></button><div className="measurement-brand"><img src="/toklo.svg" alt="" /><strong>toklo</strong></div><span className="measurement-sync-chip"><i />Données locales · OK</span><h2 id="dialog-title" className="visually-hidden">{title}</h2></div> : <div className="dialog-header"><div><p className="eyebrow">TOKLO · MON ATELIER</p><h2 id="dialog-title">{title}</h2></div><button className="icon-button" aria-label="Fermer" onClick={close}><X size={20} /></button></div>}
      <form onSubmit={handleSubmit}>
        {state.type === "customer" && <>
          <div className="form-grid"><FormField label="Prénom" required><input name="firstName" defaultValue={existingCustomer?.firstName} required autoFocus /></FormField><FormField label="Nom" required><input name="lastName" defaultValue={existingCustomer?.lastName} required /></FormField><FormField label="Téléphone / WhatsApp" required hint="Ex. 07 00 00 00 00"><input name="phone" type="tel" inputMode="tel" defaultValue={existingCustomer?.phone} required /></FormField><FormField label="Catégorie"><select name="category" defaultValue={existingCustomer?.category ?? "Femme"}>{CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></FormField><FormField label="Quartier"><input name="neighborhood" defaultValue={existingCustomer?.neighborhood} placeholder="Ex. Cocody" /></FormField><FormField label="Notes" className="full-field"><textarea name="notes" rows={3} defaultValue={existingCustomer?.notes} placeholder="Informations utiles sur ce client…" /></FormField></div>
          <label className="checkbox-row"><input type="checkbox" name="photoConsent" defaultChecked={existingCustomer?.photoConsent} /><span>Le client a donné son accord pour conserver une photo de référence.</span></label>
          {existingCustomer && <p className="form-hint">Code client : <strong>{existingCustomer.code}</strong></p>}
        </>}
        {state.type === "measurement" && <>
          <div className="measurement-page-title"><h2>Mesures</h2><span>{selectedCustomer ? `Fiche de ${customerName(selectedCustomer)}` : "Nouvelle fiche client"}</span></div>
          <div className="garment-pills">{GARMENTS.map((item) => <button key={item} type="button" className={garment === item ? "selected" : ""} onClick={() => { setGarment(item); setMeasurementValues({}); setShowAllMeasurements(false); }}>{item === "Boubou / tenue traditionnelle" ? "Boubou" : item}</button>)}</div>
          <div className="form-grid measurement-client-fields"><FormField label="Nom du client" required><input name="customerName" value={measurementName} onChange={(event) => setMeasurementName(event.target.value)} placeholder="Nom et prénom" required /></FormField><FormField label="Téléphone" required><input name="customerPhone" type="tel" inputMode="tel" value={measurementPhone} onChange={(event) => setMeasurementPhone(event.target.value)} placeholder="+225 …" required /></FormField><FormField label="Date de retour"><input name="returnDate" type="date" /></FormField><FormField label="Unité"><select value={unit} onChange={(event) => setUnit(event.target.value as "cm" | "in")}><option value="cm">Centimètres (cm)</option><option value="in">Pouces (in)</option></select></FormField></div>
          <input type="hidden" name="customerId" value={measurementCustomerId} />
          <div className="measurement-form-head"><div><h3>{garment}</h3><p>Saisissez les mesures en centimètres.</p></div><button type="button" className="listen-button" onClick={() => speak(`Mesures de ${garment}. ${visibleFields.join(", ")}`)}><Headphones size={16} /> Écouter</button></div>
          {visibleFields.length > 0 && <div className="measurement-fields">{visibleFields.map((field) => {
            const value = Number(measurementValues[field]);
            const unusual = measurementValues[field] && (!Number.isFinite(value) || value <= 0 || value > 300);
            const label = field === "Tour de bassin" ? "Hanches" : field;
            return <label className="measurement-input" key={field}><span>{label}<button type="button" aria-label={`Écouter ${label}`} onClick={() => speak(label)}><Headphones size={13} /></button></span><div><input aria-invalid={Boolean(unusual)} inputMode="decimal" type="number" step="0.1" min="0" value={measurementValues[field] ?? ""} onChange={(event) => setMeasurementValues((current) => ({ ...current, [field]: event.target.value }))} placeholder="cm" /><i>{unit}</i></div>{unusual && <small className="measurement-warning">Valeur à vérifier</small>}</label>;
          })}</div>}
          {garment === "Robe" && fields.length > primaryRobeFields.length && <button className="show-more-measurements" type="button" onClick={() => setShowAllMeasurements((shown) => !shown)}>{showAllMeasurements ? "Afficher moins" : "Plus de mesures"}</button>}
          <div className="custom-measure-row"><input name="customField" value={customField} onChange={(event) => setCustomField(event.target.value)} placeholder="Ajouter une mesure personnalisée" /><input name="customValue" type="number" inputMode="decimal" step="0.1" min="0" placeholder={unit} /></div>
          <FormField label="Notes de la fiche"><textarea name="notes" rows={2} placeholder="Notez une particularité…" /></FormField>
        </>}
        {state.type === "order" && <>
          <div className="form-grid"><FormField label="Client" required><select name="customerId" required defaultValue={initialCustomerId ?? ""}><option value="" disabled>Choisir un client</option>{customerOptions.map((customer) => <option value={customer.id} key={customer.id}>{customerName(customer)}</option>)}</select></FormField><FormField label="Vêtement" required><select value={garment} onChange={(event) => setGarment(event.target.value as Garment)}>{GARMENTS.map((item) => <option key={item}>{item}</option>)}</select></FormField><FormField label="Modèle / détails"><input name="model" placeholder="Ex. col rond, manches longues…" /></FormField><FormField label="Prix total (FCFA)" required><input name="totalPrice" type="number" inputMode="numeric" min="0" step="1" required /></FormField><FormField label="Date d'essayage"><input name="fittingDate" type="date" /></FormField><FormField label="Livraison promise" required><input name="dueDate" type="date" required /></FormField><FormField label="Avance reçue (facultatif)"><input name="advance" type="number" inputMode="numeric" min="0" step="1" defaultValue="0" /></FormField><FormField label="Canal de l'avance"><select name="channel">{CHANNELS.map((channel) => <option key={channel}>{channel}</option>)}</select></FormField><FormField label="Notes" className="full-field"><textarea name="notes" rows={2} placeholder="Tissu, finitions ou consignes…" /></FormField>
            <FormField label="Photos tissu ou modèle (400 Ko max chacune)" className="full-field"><input type="file" accept="image/*" capture="environment" multiple onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              void Promise.all(files.map(compressPhoto)).then((compressed) => setPhotos((current) => [...current, ...compressed])).catch((cause: unknown) => {
                console.error("La photo de commande n'a pas pu être préparée.", cause);
                setMediaError(cause instanceof Error ? cause.message : "La photo n'a pas pu être ajoutée.");
              }).finally(() => { event.target.value = ""; });
            }} /></FormField>
          </div>
          {photos.length > 0 && <div className="photo-previews">{photos.map((photo, index) => <img src={photo} alt={`Référence du modèle ${index + 1}`} key={`${index}-${photo.slice(0, 24)}`} />)}</div>}
          <div className="voice-note-row"><button type="button" className={`button ${recording ? "button-recording" : "button-outline"}`} onClick={() => void toggleRecording()}><Mic size={16} />{recording ? "Arrêter l'enregistrement" : "Enregistrer une note vocale"}</button>{voiceNote && <audio controls src={voiceNote} aria-label="Écouter la note vocale" />}</div>
          {mediaError && <p className="media-error" role="alert">{mediaError}</p>}
        </>}
        {state.type === "appointment" && <div className="form-grid"><FormField label="Client" required><select name="customerId" required defaultValue={initialCustomerId ?? ""}><option value="" disabled>Choisir un client</option>{customerOptions.map((customer) => <option value={customer.id} key={customer.id}>{customerName(customer)} · {customer.phone}</option>)}</select></FormField><FormField label="Motif"><select name="reason"><option>Essayage</option><option>Prise de mesures</option><option>Retrait</option></select></FormField><FormField label="Date" required><input name="date" type="date" defaultValue={dateInputValue()} required /></FormField><FormField label="Heure" required><input name="time" type="time" defaultValue={timeInputValue()} required /></FormField><FormField label="Notes" className="full-field"><textarea name="notes" rows={3} placeholder="Détails du rendez-vous…" /></FormField></div>}
        {state.type === "payment" && orderForDialog && <><div className="payment-context"><div className="order-mini-icon"><CircleDollarSign size={19} /></div><div><strong>{customerName(customerById(orderForDialog.customerId))}</strong><small>{orderForDialog.reference} · {orderForDialog.garment}</small></div><span>Reste {formatMoney(orderBalance)}</span></div><div className="form-grid"><FormField label="Montant reçu (FCFA)" required><input name="amount" type="number" inputMode="numeric" min="1" max={orderBalance} step="1" required autoFocus /></FormField><FormField label="Canal d'encaissement" required><select name="channel">{CHANNELS.map((channel) => <option key={channel}>{channel}</option>)}</select></FormField></div><p className="form-hint">Enregistrez uniquement les paiements effectivement reçus.</p></>}
        <div className="dialog-actions">
          {existingCustomer && <button type="button" className="button button-danger" onClick={() => {
            if (!window.confirm(`Archiver la fiche de ${customerName(existingCustomer)} ?`)) return;
            void save("customers", { ...existingCustomer, deletedAt: nowIso(), updatedAt: nowIso() });
          }}>Archiver la fiche</button>}
          <button type="button" className="button button-outline" onClick={close}>Annuler</button><button className="button button-primary" type="submit" disabled={(state.type === "order" || state.type === "appointment") && customerOptions.length === 0}><Check size={17} />{state.type === "payment" ? "Enregistrer le paiement" : state.type === "customer" ? "Enregistrer le client" : state.type === "measurement" ? "Enregistrer la mesure" : state.type === "order" ? "Créer la commande" : "Ajouter au calendrier"}</button></div>
      </form>
      {state.type === "measurement" && <p className="modal-footnote"><AlertTriangle size={14} /> Les valeurs sont conservées telles que saisies. Vérifiez-les physiquement avant la coupe.</p>}
    </div>
  </div>;
}

function FormField({ label, required, hint, className, children }: { label: string; required?: boolean; hint?: string; className?: string; children: ReactNode }) {
  return <label className={`form-field ${className ?? ""}`}><span>{label}{required && <i> *</i>}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function ReceiptDialog({ order, data, customerById, close }: { order?: Order; data: TokloData; customerById: (id: string) => Customer | undefined; close: () => void }) {
  if (!order) return null;
  const customer = customerById(order.customerId);
  const payments = data.payments.filter((payment) => payment.orderId === order.id);
  const balance = remainingBalance(order, data.payments);
  const share = () => {
    const text = `Toklo — Reçu de commande ${order.reference}\nClient : ${customerName(customer)}\nVêtement : ${order.garment}\nPrix total : ${formatMoney(order.totalPrice)}\nDéjà payé : ${formatMoney(order.totalPrice - balance)}\nReste à payer : ${formatMoney(balance)}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div className="dialog receipt-dialog">
    <div className="dialog-header"><div><p className="eyebrow">TOKLO · REÇU</p><h2>Commande {order.reference}</h2></div><button className="icon-button" aria-label="Fermer" onClick={close}><X size={20} /></button></div>
    <div className="receipt-paper"><div className="receipt-brand"><span className="brand-mark"><Shirt size={19} /></span><div><strong>toklo</strong><small>REÇU DE COMMANDE</small></div></div><div className="receipt-divider" /><div className="receipt-line"><span>Client</span><strong>{customerName(customer)}</strong></div><div className="receipt-line"><span>Téléphone</span><strong>{customer?.phone ?? "—"}</strong></div><div className="receipt-line"><span>Vêtement</span><strong>{order.garment}</strong></div><div className="receipt-line"><span>Référence</span><strong>{order.reference}</strong></div><div className="receipt-line"><span>Date promise</span><strong>{readableDate(order.dueDate)}</strong></div><div className="receipt-divider" /><div className="receipt-line"><span>Prix total</span><strong>{formatMoney(order.totalPrice)}</strong></div><div className="receipt-line"><span>Déjà payé</span><strong>{formatMoney(order.totalPrice - balance)}</strong></div><div className="receipt-total"><span>Reste à payer</span><strong>{formatMoney(balance)}</strong></div>{payments.length > 0 && <div className="receipt-payments"><span>Paiements enregistrés</span>{payments.map((payment) => <small key={payment.id}>{readableDate(payment.date)} · {payment.channel} · {formatMoney(payment.amount)}</small>)}</div>}<p className="receipt-thanks">Merci de votre confiance ✦</p></div>
    <div className="dialog-actions"><button className="button button-outline" onClick={close}>Fermer</button><button className="button button-outline" onClick={() => window.print()}><Printer size={17} /> Imprimer</button><button className="button button-primary" onClick={share}>Partager sur WhatsApp</button></div>
  </div></div>;
}

function printMeasurement(measurement: Measurement, customer?: Customer) {
  const content = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Mesures Toklo</title><style>body{font:16px Arial,sans-serif;color:#302d28;padding:32px}h1{color:#4d6655}table{border-collapse:collapse;width:100%;margin-top:24px}td{padding:10px;border-bottom:1px solid #ddd}td:last-child{text-align:right;font-weight:bold}.meta{color:#666}</style></head><body><h1>Toklo — Fiche de mesures</h1><p>${customerName(customer)} · ${customer?.phone ?? ""}</p><p class="meta">${measurement.garment} · ${readableDate(measurement.date)} · ${measurement.unit}</p><table>${Object.entries(measurement.values).filter(([, value]) => value).map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)} ${measurement.unit}</td></tr>`).join("")}</table><p>${escapeHtml(measurement.notes)}</p><script>window.print()</script></body></html>`;
  const popup = window.open("", "_blank", "noopener,noreferrer");
  if (!popup) {
    window.alert("Autorisez les fenêtres contextuelles pour imprimer cette fiche.");
    return;
  }
  popup.document.write(content);
  popup.document.close();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function csvSafe(text: unknown): string {
  const value = String(text ?? "");
  return `"${value.replaceAll('"', '""')}"`;
}

function isTokloData(value: unknown): value is TokloData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return ["customers", "measurements", "orders", "payments", "appointments"].every((key) => Array.isArray(data[key]));
}
