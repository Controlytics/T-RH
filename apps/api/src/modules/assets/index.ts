import type { FastifyInstance } from 'fastify';
import templateRoutes from './routes/template.routes.js';
import instanceRoutes from './routes/instance.routes.js';
import identifierRoutes from './routes/identifier.routes.js';

export default async function assetRoutes(app: FastifyInstance) {
  await app.register(templateRoutes);
  await app.register(instanceRoutes);
  await app.register(identifierRoutes);
}
