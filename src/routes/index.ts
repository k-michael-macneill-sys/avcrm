import { Router } from 'express';
import { auditLogRouter } from './audit';
import { authRouter } from './auth';
import { branchesRouter } from './branches';
import { checklistRequirementsRouter, contractsRouter } from './contracts';
import { customersRouter } from './customers';
import { messageLogRouter, messageTemplatesRouter } from './messages';
import { documentRequirementsRouter, operatorsRouter } from './operators';
import { pricingGuideRouter } from './pricing';
import { propertiesRouter } from './properties';
import { quotesRouter } from './quotes';
import { reviewRequestsRouter } from './reviews';
import { usersRouter } from './users';
import { workOrdersRouter } from './workOrders';

/**
 * One place to see the whole surface. Adding a resource is: write the service,
 * write the route file, mount it here.
 *
 * Invoices and payments arrive in build step 6 and mount here the same way.
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
apiRouter.use('/work-orders', workOrdersRouter);
apiRouter.use('/message-templates', messageTemplatesRouter);
apiRouter.use('/message-log', messageLogRouter);
apiRouter.use('/review-requests', reviewRequestsRouter);
apiRouter.use('/audit-log', auditLogRouter);
