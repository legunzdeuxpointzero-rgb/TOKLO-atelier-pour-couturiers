export type Category = "Femme" | "Homme" | "Enfant";
export type Garment = "Robe" | "Chemise" | "Pantalon" | "Jupe" | "Veste" | "Boubou / tenue traditionnelle" | "Autre";
export type OrderStatus =
  | "Brouillon"
  | "En coupe"
  | "En montage"
  | "Prêt pour essayage"
  | "Retouches"
  | "Terminé"
  | "Livré"
  | "Annulé";
export type PaymentChannel = "Espèces" | "Wave" | "Orange Money" | "MTN MoMo" | "Moov Money";
export type AppointmentReason = "Prise de mesures" | "Essayage" | "Retrait";
export type AppointmentStatus = "Prévu" | "Fait" | "Annulé";

export interface BaseRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface Customer extends BaseRecord {
  code: string;
  firstName: string;
  lastName: string;
  phone: string;
  category: Category;
  neighborhood: string;
  notes: string;
  photoConsent: boolean;
}

export interface Measurement extends BaseRecord {
  customerId: string;
  garment: Garment;
  date: string;
  returnDate?: string;
  unit: "cm" | "in";
  values: Record<string, string>;
  notes: string;
  author: string;
}

export interface StatusChange {
  status: OrderStatus;
  date: string;
}

export interface Order extends BaseRecord {
  reference: string;
  customerId: string;
  garment: Garment;
  model: string;
  status: OrderStatus;
  fittingDate: string;
  dueDate: string;
  totalPrice: number;
  notes: string;
  photos?: string[];
  voiceNote?: string;
  statusHistory: StatusChange[];
}

export interface Payment extends BaseRecord {
  orderId: string;
  amount: number;
  channel: PaymentChannel;
  date: string;
}

export interface Appointment extends BaseRecord {
  customerId: string;
  dateTime: string;
  reason: AppointmentReason;
  status: AppointmentStatus;
  notes: string;
}

export interface TokloData {
  customers: Customer[];
  measurements: Measurement[];
  orders: Order[];
  payments: Payment[];
  appointments: Appointment[];
}

export type TableName = keyof TokloData;
export type RecordFor<T extends TableName> = TokloData[T][number];
