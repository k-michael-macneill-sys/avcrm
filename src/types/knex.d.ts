import type {
  AuditLogEntry,
  Branch,
  ChecklistRequirement,
  Contract,
  ContractChecklistItem,
  Customer,
  DocumentRequirement,
  OperatorDocument,
  PricingGuideEntry,
  Property,
  Quote,
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
    pricing_guide: PricingGuideEntry;
    quotes: Quote;
    checklist_requirements: ChecklistRequirement;
    contracts: Contract;
    contract_checklist_items: ContractChecklistItem;
    audit_log: AuditLogEntry;
  }
}
