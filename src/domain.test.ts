import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { allowedNextStatuses, customerCode, orderRisk, paymentIsValid, remainingBalance } from "./domain";
import { closeDatabaseForTests, listRecords, replaceAll, saveRecord } from "./db";
import type { Customer, Measurement, Order, Payment, TokloData } from "./types";

const now = "2026-11-13T10:00:00.000Z";
const order: Order = {
  id: "order-1",
  reference: "CMD-001",
  customerId: "customer-1",
  garment: "Robe",
  model: "",
  status: "En montage",
  fittingDate: "",
  dueDate: "2026-11-15",
  totalPrice: 25_000,
  notes: "",
  statusHistory: [{ status: "Brouillon", date: now }],
  createdAt: now,
  updatedAt: now,
};

describe("Toklo domain rules", () => {
  it("calculates remaining balance from successive payments without going negative", () => {
    const payments: Payment[] = [
      { id: "p1", orderId: order.id, amount: 10_000, channel: "Wave", date: now, createdAt: now, updatedAt: now },
      { id: "p2", orderId: order.id, amount: 5_000, channel: "Espèces", date: now, createdAt: now, updatedAt: now },
    ];
    expect(remainingBalance(order, payments)).toBe(10_000);
    expect(remainingBalance({ ...order, totalPrice: 12_000 }, payments)).toBe(0);
  });

  it("rejects non-positive payments and amounts above the balance", () => {
    expect(paymentIsValid(100, 100)).toBe(true);
    expect(paymentIsValid(101, 100)).toBe(false);
    expect(paymentIsValid(0, 100)).toBe(false);
  });

  it("marks overdue and imminent orders but not completed orders", () => {
    expect(orderRisk({ ...order, dueDate: "2026-11-12" }, new Date("2026-11-13T10:00:00"))).toBe("late");
    expect(orderRisk(order, new Date("2026-11-13T10:00:00"))).toBe("risk");
    expect(orderRisk({ ...order, status: "Terminé" }, new Date("2026-11-13T10:00:00"))).toBeNull();
  });

  it("generates readable customer codes", () => {
    expect(customerCode(27)).toMatch(/^C-0027-[A-Z0-9]{2}$/);
  });

  it("only allows valid next steps in the order workflow", () => {
    expect(allowedNextStatuses("Brouillon")).toEqual(["En coupe", "Annulé"]);
    expect(allowedNextStatuses("Retouches")).toEqual(["Prêt pour essayage", "Annulé"]);
    expect(allowedNextStatuses("Livré")).toEqual([]);
  });
});

describe("local database", () => {
  beforeEach(async () => {
    await closeDatabaseForTests();
    indexedDB.deleteDatabase("toklo-local");
  });

  it("persists customers and excludes logically deleted records", async () => {
    const customer: Customer = {
      id: "customer-1",
      code: "C-0001-AB",
      firstName: "Awa",
      lastName: "Kouassi",
      phone: "0700000000",
      category: "Femme",
      neighborhood: "",
      notes: "",
      photoConsent: false,
      createdAt: now,
      updatedAt: now,
    };
    await saveRecord("customers", customer);
    expect(await listRecords("customers")).toHaveLength(1);
    await saveRecord("customers", { ...customer, deletedAt: now });
    expect(await listRecords("customers")).toHaveLength(0);
  });

  it("persists a measurement return date", async () => {
    const measurement: Measurement = {
      id: "measurement-1",
      customerId: "customer-1",
      garment: "Robe",
      date: "2026-11-13",
      returnDate: "2026-11-20",
      unit: "cm",
      values: { "Tour de taille": "72" },
      notes: "",
      author: "Atelier",
      createdAt: now,
      updatedAt: now,
    };
    await saveRecord("measurements", measurement);
    expect(await listRecords("measurements")).toEqual([measurement]);
  });

  it("restores a full backup across all local tables", async () => {
    const customer: Customer = {
      id: "customer-2",
      code: "C-0002-CD",
      firstName: "Mariam",
      lastName: "Traoré",
      phone: "0500000000",
      category: "Femme",
      neighborhood: "",
      notes: "",
      photoConsent: false,
      createdAt: now,
      updatedAt: now,
    };
    const backup: TokloData = { customers: [customer], measurements: [], orders: [], payments: [], appointments: [] };
    await replaceAll(backup);
    expect(await listRecords("customers")).toEqual([customer]);
    expect(await listRecords("orders")).toEqual([]);
  });
});
