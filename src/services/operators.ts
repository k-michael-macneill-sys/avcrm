import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type {
  DocumentRequirement,
  DocumentStatus,
  OnboardingStatus,
  OperatorDocument,
  PublicUser,
} from '../types/models';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { isPgError, PG_UNIQUE_VIOLATION } from '../utils/pg';
import { applyBranchScope } from '../utils/scope';
import { PUBLIC_USER_COLUMNS } from './auth';

/**
 * Requirements that apply to a province: the global ones (province IS NULL)
 * plus any specific to that province.
 */
export async function requirementsForProvince(
  province: string,
  db: Knex = defaultDb,
): Promise<DocumentRequirement[]> {
  return db('document_requirements')
    .where('province', province)
    .orWhereNull('province')
    .orderBy('code', 'asc')
    .select('*');
}

export async function listOperatorDocuments(
  userId: string,
  db: Knex = defaultDb,
): Promise<OperatorDocument[]> {
  return db('operator_documents')
    .where({ user_id: userId })
    .orderBy([
      { column: 'requirement_code', order: 'asc' },
      { column: 'created_at', order: 'desc' },
    ])
    .select('*');
}

export interface SubmitDocumentInput {
  requirement_code: string;
  file_url: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  issued_on: string | null;
  expires_on: string | null;
}

/**
 * Records a document an operator has uploaded. The file itself goes to a
 * private bucket before this is called; only the key is stored.
 *
 * When the requirement expires and the caller did not supply expires_on, it is
 * derived from issued_on plus the requirement's default validity.
 */
export async function submitDocument(
  userId: string,
  input: SubmitDocumentInput,
  db: Knex = defaultDb,
): Promise<OperatorDocument> {
  const requirement = await db('document_requirements')
    .where({ code: input.requirement_code })
    .first();
  if (!requirement) {
    throw badRequest('requirement_code does not match a known requirement');
  }

  let expiresOn = input.expires_on;
  if (requirement.expires && !expiresOn) {
    if (!input.issued_on) {
      throw badRequest(
        `${requirement.label} expires, so issued_on or expires_on is required`,
      );
    }
    expiresOn = addDays(input.issued_on, requirement.default_validity_days ?? 365);
  }
  if (!requirement.expires) {
    expiresOn = null;
  }

  try {
    const [document] = await db('operator_documents')
      .insert({
        user_id: userId,
        requirement_code: input.requirement_code,
        file_url: input.file_url,
        file_name: input.file_name,
        mime_type: input.mime_type,
        file_size: input.file_size,
        issued_on: input.issued_on,
        expires_on: expiresOn,
        status: 'submitted',
      })
      .returning('*');
    if (!document) {
      throw new Error('Insert returned no document row');
    }

    await refreshOnboardingStatus(userId, db);
    return document;
  } catch (err) {
    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw conflict(
        'There is already a submitted or approved document for that requirement',
      );
    }
    throw err;
  }
}

export interface ReviewInput {
  status: Extract<DocumentStatus, 'approved' | 'rejected'>;
  rejection_reason: string | null;
}

/** Corporate approves or rejects. Reviewer identity is recorded either way. */
export async function reviewDocument(
  documentId: string,
  reviewerId: string,
  input: ReviewInput,
  db: Knex = defaultDb,
): Promise<OperatorDocument> {
  if (input.status === 'rejected' && !input.rejection_reason) {
    throw badRequest('rejection_reason is required when rejecting a document');
  }

  const document = await db('operator_documents').where({ id: documentId }).first();
  if (!document) {
    throw notFound('Document not found');
  }
  if (document.status !== 'submitted') {
    throw conflict(`Only submitted documents can be reviewed (this one is ${document.status})`);
  }

  const [updated] = await db('operator_documents')
    .where({ id: documentId })
    .update({
      status: input.status,
      rejection_reason: input.status === 'rejected' ? input.rejection_reason : null,
      reviewed_by_user_id: reviewerId,
      reviewed_at: new Date(),
    })
    .returning('*');

  if (!updated) {
    throw notFound('Document not found');
  }

  await refreshOnboardingStatus(document.user_id, db);
  return updated;
}

export interface ComplianceItem {
  requirement_code: string;
  label: string;
  is_required: boolean;
  expires: boolean;
  status: DocumentStatus | 'missing';
  expires_on: string | null;
  document_id: string | null;
}

export interface OperatorCompliance {
  user_id: string;
  onboarding_status: string;
  assignable: boolean;
  missing_required: string[];
  items: ComplianceItem[];
}

/**
 * The compliance picture for one operator: every requirement that applies in
 * their branch's province, matched against their live documents.
 */
export async function operatorCompliance(
  userId: string,
  db: Knex = defaultDb,
): Promise<OperatorCompliance> {
  const user = (await db('users')
    .leftJoin('branches', 'branches.id', 'users.branch_id')
    .where('users.id', userId)
    .first([
      'users.id',
      'users.onboarding_status',
      'users.is_active',
      'branches.province as province',
    ])) as
    | {
        id: string;
        onboarding_status: OnboardingStatus;
        is_active: boolean;
        province: string | null;
      }
    | undefined;
  if (!user) {
    throw notFound('Operator not found');
  }

  const requirements = await requirementsForProvince(user.province ?? '', db);
  const documents = await db('operator_documents')
    .where({ user_id: userId })
    .whereIn('status', ['submitted', 'approved'])
    .select('*');

  const items: ComplianceItem[] = requirements.map((requirement) => {
    const document = documents.find((d) => d.requirement_code === requirement.code);
    return {
      requirement_code: requirement.code,
      label: requirement.label,
      is_required: requirement.is_required,
      expires: requirement.expires,
      status: document ? document.status : 'missing',
      expires_on: document?.expires_on ?? null,
      document_id: document?.id ?? null,
    };
  });

  const missingRequired = items
    .filter((item) => item.is_required && item.status !== 'approved')
    .map((item) => item.requirement_code);

  return {
    user_id: user.id,
    onboarding_status: user.onboarding_status,
    assignable: user.is_active && user.onboarding_status === 'approved',
    missing_required: missingRequired,
    items,
  };
}

/**
 * Moves an operator between pending / docs_submitted / approved as their
 * documents change. A suspended operator is left alone: only the nightly job
 * or a corporate user lifts a suspension.
 */
export async function refreshOnboardingStatus(
  userId: string,
  db: Knex = defaultDb,
): Promise<void> {
  const user = await db('users')
    .where({ id: userId })
    .first('id', 'role', 'onboarding_status');
  if (!user || user.role !== 'operator' || user.onboarding_status === 'suspended') {
    return;
  }

  const compliance = await operatorCompliance(userId, db);
  const hasAny = compliance.items.some((item) => item.status !== 'missing');

  let next: OnboardingStatus;
  if (compliance.missing_required.length === 0) {
    next = 'approved';
  } else if (hasAny) {
    next = 'docs_submitted';
  } else {
    next = 'pending';
  }

  if (next !== user.onboarding_status) {
    await db('users').where({ id: userId }).update({ onboarding_status: next });
  }
}

/**
 * The gate from the spec: an operator who is not approved cannot be assigned
 * work orders. Called by the work order routes in build step 4, and used by
 * the assignable filter on GET /operators.
 */
export async function assertOperatorAssignable(
  userId: string,
  db: Knex = defaultDb,
): Promise<void> {
  const user = await db('users')
    .where({ id: userId })
    .first('id', 'role', 'is_active', 'onboarding_status');

  if (!user || user.role !== 'operator') {
    throw badRequest('assigned_user_id must be an operator');
  }
  if (!user.is_active) {
    throw forbidden('That operator is deactivated');
  }
  if (user.onboarding_status !== 'approved') {
    throw forbidden(
      `That operator cannot be assigned work: onboarding status is ${user.onboarding_status}`,
    );
  }
}

export async function listOperators(
  scope: BranchScope,
  options: { assignable?: boolean },
  db: Knex = defaultDb,
): Promise<PublicUser[]> {
  const query = applyBranchScope(db('users'), 'branch_id', scope).andWhere({
    role: 'operator',
  });

  if (options.assignable) {
    query.andWhere({ is_active: true, onboarding_status: 'approved' });
  }

  const rows = await query
    .orderBy([{ column: 'last_name', order: 'asc' }, { column: 'first_name', order: 'asc' }])
    .select([...PUBLIC_USER_COLUMNS]);
  return rows as PublicUser[];
}

/** Adds whole days to a YYYY-MM-DD date, returning the same format. */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
