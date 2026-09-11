import type {
  AuditLogEntry,
  Branch,
  ChecklistRequirement,
  Contract,
  ContractChecklistItem,
  Customer,
  DocumentRequirement,
  Invoice,
  MessageLogEntry,
  MessageTemplate,
  OperatorDocument,
  Payment,
  PricingGuideEntry,
  Property,
  Quote,
  ReviewRequest,
  ServicePhoto,
  Upload,
  User,
  WorkOrder,
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
    work_orders: WorkOrder;
    service_photos: ServicePhoto;
    message_templates: MessageTemplate;
    message_log: MessageLogEntry;
    review_requests: ReviewRequest;
    invoices: Invoice;
    payments: Payment;
    uploads: Upload;
    audit_log: AuditLogEntry;
  }
}
