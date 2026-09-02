import { Router } from 'express';
import { authRouter } from './auth';
import { branchesRouter } from './branches';
import { contractsRouter } from './contracts';
import { customersRouter } from './customers';
import { jobsRouter } from './jobs';
import { paymentsRouter } from './payments';

/**
 * One place to see the whole surface. Adding a resource is: write the service,
 * write the route file, mount it here.
 */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/branches', branchesRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/jobs', jobsRouter);
apiRouter.use('/contracts', contractsRouter);
apiRouter.use('/payments', paymentsRouter);
