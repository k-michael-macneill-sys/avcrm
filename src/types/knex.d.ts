import type {
  Branch,
  Contract,
  Customer,
  Inspection,
  Job,
  Payment,
  User,
} from './models';

declare module 'knex/types/tables' {
  interface Tables {
    branches: Branch;
    users: User;
    customers: Customer;
    jobs: Job;
    contracts: Contract;
    payments: Payment;
    inspections: Inspection;
  }
}
