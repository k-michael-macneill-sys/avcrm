import type {
  Branch,
  Customer,
  DocumentRequirement,
  OperatorDocument,
  Property,
  User,
} from './models';

declare module 'knex/types/tables' {
  interface Tables {
    branches: Branch;
    users: User;
    document_requirements: DocumentRequirement;
    operator_documents: OperatorDocument;
    customers: Customer;
    properties: Property;
  }
}
