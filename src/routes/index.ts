import { Router } from 'express';
import { authRouter } from './auth';
import { branchesRouter } from './branches';
import { customersRouter } from './customers';
import { documentRequirementsRouter, operatorsRouter } from './operators';
import { propertiesRouter } from './properties';
import { usersRouter } from './users';

/**
 * One place to see the whole surface. Adding a resource is: write the service,
 * write the route file, mount it here.
 *
 * Quotes, contracts, work orders, invoices and payments arrive in build steps
 * 3 to 6 and mount here the same way.
 */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/branches', branchesRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/operators', operatorsRouter);
apiRouter.use('/document-requirements', documentRequirementsRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/properties', propertiesRouter);
