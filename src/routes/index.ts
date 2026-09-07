import { Router } from 'express';
import { auditLogRouter } from './audit';
import { authRouter } from './auth';
import { branchesRouter } from './branches';
import { checklistRequirementsRouter, contractsRouter } from './contracts';
import { customersRouter } from './customers';
import { documentRequirementsRouter, operatorsRouter } from './operators';
import { pricingGuideRouter } from './pricing';
import { propertiesRouter } from './properties';
import { quotesRouter } from './quotes';
import { usersRouter } from './users';

/**
 * One place to see the whole surface. Adding a resource is: write the service,
 * write the route file, mount it here.
 *
 * Work orders, invoices and payments arrive in build steps 4 to 6 and mount
 * here the same way.
 */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/branches', branchesRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/operators', operatorsRouter);
apiRouter.use('/document-requirements', documentRequirementsRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/properties', propertiesRouter);
apiRouter.use('/pricing-guide', pricingGuideRouter);
apiRouter.use('/quotes', quotesRouter);
apiRouter.use('/checklist-requirements', checklistRequirementsRouter);
apiRouter.use('/contracts', contractsRouter);
apiRouter.use('/audit-log', auditLogRouter);
