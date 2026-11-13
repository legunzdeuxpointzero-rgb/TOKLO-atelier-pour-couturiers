import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { RecordFor, TableName, TokloData } from "./types";

interface TokloSchema extends DBSchema {
  customers: { key: string; value: TokloData["customers"][number] };
  measurements: { key: string; value: TokloData["measurements"][number]; indexes: { "by-customer": string } };
  orders: { key: string; value: TokloData["orders"][number]; indexes: { "by-customer": string } };
  payments: { key: string; value: TokloData["payments"][number]; indexes: { "by-order": string } };
  appointments: { key: string; value: TokloData["appointments"][number]; indexes: { "by-customer": string } };
}

let database: Promise<IDBPDatabase<TokloSchema>> | undefined;

function getDatabase(): Promise<IDBPDatabase<TokloSchema>> {
  if (!database) {
    database = openDB<TokloSchema>("toklo-local", 1, {
      upgrade(db) {
        db.createObjectStore("customers", { keyPath: "id" });
        const measurements = db.createObjectStore("measurements", { keyPath: "id" });
        measurements.createIndex("by-customer", "customerId");
        const orders = db.createObjectStore("orders", { keyPath: "id" });
        orders.createIndex("by-customer", "customerId");
        const payments = db.createObjectStore("payments", { keyPath: "id" });
        payments.createIndex("by-order", "orderId");
        const appointments = db.createObjectStore("appointments", { keyPath: "id" });
        appointments.createIndex("by-customer", "customerId");
      },
    });
  }
  return database;
}

export async function listRecords<T extends TableName>(table: T): Promise<TokloData[T]> {
  const db = await getDatabase();
  return (await db.getAll(table)).filter((record) => !record.deletedAt) as TokloData[T];
}

export async function saveRecord<T extends TableName>(table: T, record: RecordFor<T>): Promise<void> {
  const db = await getDatabase();
  await db.put(table, record as TokloData[T][number]);
}

export async function loadAll(): Promise<TokloData> {
  const [customers, measurements, orders, payments, appointments] = await Promise.all([
    listRecords("customers"),
    listRecords("measurements"),
    listRecords("orders"),
    listRecords("payments"),
    listRecords("appointments"),
  ]);
  return { customers, measurements, orders, payments, appointments };
}

export async function replaceAll(data: TokloData): Promise<void> {
  const db = await getDatabase();
  const transaction = db.transaction(
    ["customers", "measurements", "orders", "payments", "appointments"],
    "readwrite",
  );
  await Promise.all([
    transaction.objectStore("customers").clear(),
    transaction.objectStore("measurements").clear(),
    transaction.objectStore("orders").clear(),
    transaction.objectStore("payments").clear(),
    transaction.objectStore("appointments").clear(),
  ]);
  for (const table of Object.keys(data) as TableName[]) {
    for (const record of data[table]) {
      await transaction.objectStore(table).put(record as never);
    }
  }
  await transaction.done;
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}

export async function closeDatabaseForTests(): Promise<void> {
  if (database) {
    (await database).close();
    database = undefined;
  }
}
