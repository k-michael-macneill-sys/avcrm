import { Router } from 'express';
import { auditLogRouter } from './audit';
import { authRouter } from './auth';
import { branchesRouter } from './branches';
import { cardSetupsRouter } from './cards';
import { checklistRequirementsRouter, contractsRouter } from './contracts';
import { customersRouter } from './customers';
import { invoicesRouter } from './invoices';
import { messageLogRouter, messageTemplatesRouter } from './messages';
import { metaMessagingRouter } from './metaMessaging';
import { documentRequirementsRouter, operatorsRouter } from './operators';
import { paymentsRouter } from './payments';
import { portalRouter } from './portal';
import { pricingGuideRouter } from './pricing';
import { leadsRouter } from './leads';
import { propertiesRouter } from './properties';
import { publicRouter } from './public';
import { quotesRouter } from './quotes';
import { reportsRouter } from './reports';
import { reviewRequestsRouter } from './reviews';
import { salesRouter } from './sales';
import { settingsRouter } from './settings';
import { filesRouter, uploadsRouter } from './uploads';
import { usersRouter } from './users';
import { workOrdersRouter } from './workOrders';

/**
 * One place to see the whole surface. Adding a resource is: write the service,
 * write the route file, mount it here.
 */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/public', publicRouter);
apiRouter.use('/uploads', uploadsRouter);
apiRouter.use('/files', filesRouter);
apiRouter.use('/branches', branchesRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/operators', operatorsRouter);
apiRouter.use('/document-requirements', documentRequirementsRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/properties', propertiesRouter);
apiRouter.use('/pricing-guide', pricingGuideRouter);
apiRouter.use('/quotes', quotesRouter);
apiRouter.use('/sales', salesRouter);
apiRouter.use('/leads', leadsRouter);
apiRouter.use('/checklist-requirements', checklistRequirementsRouter);
apiRouter.use('/contracts', contractsRouter);
apiRouter.use('/work-orders', workOrdersRouter);
apiRouter.use('/message-templates', messageTemplatesRouter);
apiRouter.use('/message-log', messageLogRouter);
apiRouter.use('/meta', metaMessagingRouter);
apiRouter.use('/review-requests', reviewRequestsRouter);
apiRouter.use('/card-setups', cardSetupsRouter);
apiRouter.use('/invoices', invoicesRouter);
apiRouter.use('/payments', paymentsRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/portal', portalRouter);
apiRouter.use('/audit-log', auditLogRouter);
