import type { Garment, Order, OrderStatus, Payment } from "./types";

export const GARMENTS: Garment[] = [
  "Robe",
  "Chemise",
  "Pantalon",
  "Jupe",
  "Veste",
  "Boubou / tenue traditionnelle",
  "Autre",
];

export const MEASUREMENT_FIELDS: Record<Garment, string[]> = {
  Robe: [
    "Épaule",
    "Tour de poitrine",
    "Tour de taille",
    "Tour de bassin",
    "Hauteur de poitrine",
    "Hauteur taille-bassin",
    "Longueur de manche",
    "Tour de bras",
    "Longueur de la robe",
    "Tour d'encolure",
  ],
  Chemise: [
    "Tour d'encolure",
    "Épaule",
    "Tour de poitrine",
    "Tour de taille",
    "Tour de bassin",
    "Longueur de manche",
    "Tour de poignet",
    "Tour de bras",
    "Longueur de la chemise",
  ],
  Pantalon: [
    "Tour de taille",
    "Tour de bassin",
    "Entrejambe",
    "Longueur extérieure",
    "Tour de cuisse",
    "Tour de genou",
    "Bas de jambe",
    "Hauteur de fourche",
  ],
  Jupe: ["Tour de taille", "Tour de bassin", "Hauteur taille-bassin", "Longueur de la jupe"],
  Veste: [
    "Épaule",
    "Tour de poitrine",
    "Tour de taille",
    "Tour de bassin",
    "Longueur de manche",
    "Tour de bras",
    "Longueur de la veste",
    "Carrure dos",
  ],
  "Boubou / tenue traditionnelle": [
    "Épaule",
    "Tour de poitrine",
    "Tour de bassin",
    "Longueur de manche",
    "Longueur totale",
    "Largeur du bas",
  ],
  Autre: [],
};

export const ORDER_STATUSES: OrderStatus[] = [
  "Brouillon",
  "En coupe",
  "En montage",
  "Prêt pour essayage",
  "Retouches",
  "Terminé",
  "Livré",
  "Annulé",
];

export function allowedNextStatuses(status: OrderStatus): OrderStatus[] {
  const transitions: Record<OrderStatus, OrderStatus[]> = {
    Brouillon: ["En coupe", "Annulé"],
    "En coupe": ["En montage", "Annulé"],
    "En montage": ["Prêt pour essayage", "Annulé"],
    "Prêt pour essayage": ["Retouches", "Terminé", "Annulé"],
    Retouches: ["Prêt pour essayage", "Annulé"],
    Terminé: ["Livré", "Annulé"],
    Livré: [],
    Annulé: [],
  };
  return transitions[status];
}

export function remainingBalance(order: Order, payments: Payment[]): number {
  const paid = payments
    .filter((payment) => payment.orderId === order.id && !payment.deletedAt)
    .reduce((sum, payment) => sum + payment.amount, 0);
  return Math.max(0, order.totalPrice - paid);
}

export function paymentIsValid(amount: number, balance: number): boolean {
  return Number.isFinite(amount) && amount > 0 && amount <= balance;
}

export function orderRisk(order: Order, today = new Date()): "late" | "risk" | null {
  if (!order.dueDate || ["Livré", "Annulé", "Terminé"].includes(order.status)) return null;
  const due = new Date(`${order.dueDate}T00:00:00`);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysLeft = Math.floor((due.getTime() - todayStart.getTime()) / 86_400_000);
  if (daysLeft < 0) return "late";
  if (daysLeft < 3) return "risk";
  return null;
}

export function formatMoney(amount: number): string {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(amount) + " F";
}

export function customerCode(sequence: number): string {
  return `C-${String(sequence).padStart(4, "0")}-${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
}

export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}
