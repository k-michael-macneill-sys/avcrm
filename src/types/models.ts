/**
 * Row shapes as they come back from Postgres. These mirror the migrations;
 * update both together.
 */

export const USER_ROLES = ['admin', 'manager', 'dispatcher', 'operator'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const CONTRACT_STATUSES = [
  'none',
  'pending',
  'active',
  'expired',
  'cancelled',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const JOB_STATUSES = [
  'scheduled',
  'dispatched',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ['card', 'ach', 'check', 'cash'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface Branch {
  id: string;
  name: string;
  region: string;
  created_at: Date;
}

export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: UserRole;
  branch_id: string | null;
  created_at: Date;
}

/** A user as it is safe to return over the API. */
export type PublicUser = Omit<User, 'password_hash'>;

export interface Customer {
  id: string;
  branch_id: string;
  name: string;
  phone: string | null;
  address: string | null;
  email: string | null;
  contract_status: ContractStatus;
  created_at: Date;
}

export interface Job {
  id: string;
  customer_id: string;
  branch_id: string;
  status: JobStatus;
  scheduled_date: Date | null;
  completed_date: Date | null;
  notes: string | null;
  created_at: Date;
}

export interface Contract {
  id: string;
  customer_id: string;
  price: string; // numeric(12,2) comes back as a string from pg
  start_date: string; // date column, returned as YYYY-MM-DD
  end_date: string;
  auto_renew: boolean;
  terms: string | null;
  created_at: Date;
}

export interface Payment {
  id: string;
  customer_id: string;
  amount: string;
  date: Date;
  status: PaymentStatus;
  method: PaymentMethod;
  reference: string | null;
  created_at: Date;
}

export interface Inspection {
  id: string;
  job_id: string;
  timestamp: Date;
  photo_url: string | null;
  notes: string | null;
  operator_id: string | null;
  created_at: Date;
}
