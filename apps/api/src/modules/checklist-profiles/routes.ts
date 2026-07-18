import type { FastifyInstance } from 'fastify';
import { ChecklistProfileService } from './checklist-profile.service.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { enforceReauth } from '../../lib/reauth-check.js';

export default async function checklistProfileRoutes(app: FastifyInstance) {
  const service = new ChecklistProfileService();

  app.get('/', {
    // FILTER_OPERATE is accepted here because the mobile tablet's offline sync
    // fetches this endpoint (expand=questions) to cache the checklist payload
    // so operators can answer checklists offline. An operator who can OPERATE a
    // filter MUST be able to read the checklists they'll fill — without this,
    // roles that hold FILTER_OPERATE but not FCP_READ (e.g. the OPERATOR role
    // as configured on live) get a 403 on sync, the checklist cache is left
    // empty, and the offline executor silently skips required checklists
    // (2026-07-10 root cause of "checklist not appearing offline").
    preHandler: [app.requireAnyPermission('FCP_READ', 'CHECKLIST_TOGGLE', 'VERSION_HISTORY_VIEW', 'FILTER_OPERATE')],
    // expand=questions inlines questions[] on each row — used by the mobile
    // tablet to cache the full checklist payload for offline use. Without
    // adding this to the schema, Fastify strips the unknown query param.
    schema: { tags: ['Checklist Profiles'], querystring: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, isActive: { type: 'string' }, expand: { type: 'string' } } }, response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req) => service.list(buildContext(req), req.query as any));

  app.get('/:id', {
    preHandler: [app.requireAnyPermission('FCP_READ', 'CHECKLIST_TOGGLE', 'VERSION_HISTORY_VIEW')],
    schema: { tags: ['Checklist Profiles'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req) => service.getById(buildContext(req), (req.params as any).id));

  app.post('/', {
    preHandler: [app.requireAnyPermission('FCP_CREATE', 'CHECKLIST_CREATE')],
    schema: { tags: ['Checklist Profiles'], body: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' } } }, response: { 201: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_CHECKLIST_PROFILE', req, reply);
    if (!ok) return;
    const r = await service.create(buildContext(req), req.body);
    return reply.code(201).send(r);
  });

  app.put('/:id', {
    preHandler: [app.requireAnyPermission('FCP_UPDATE', 'CHECKLIST_EDIT')],
    schema: { tags: ['Checklist Profiles'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, isActive: { type: 'boolean' } } }, response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_CHECKLIST_PROFILE', req, reply);
    if (!ok) return;
    return service.update(buildContext(req), (req.params as any).id, req.body);
  });

  app.delete('/:id', {
    preHandler: [app.requireAnyPermission('FCP_DELETE', 'CHECKLIST_DELETE')],
    schema: { tags: ['Checklist Profiles'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_CHECKLIST_PROFILE', req, reply);
    if (!ok) return;
    return service.delete(buildContext(req), (req.params as any).id);
  });

  // Questions
  app.post('/:id/questions', {
    preHandler: [app.requireAnyPermission('FCP_CREATE', 'CHECKLIST_CREATE')],
    schema: { tags: ['Checklist Questions'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', required: ['question'], properties: { question: { type: 'string' }, questionType: { type: 'string' }, required: { type: 'boolean' }, section: { type: 'string' }, description: { type: 'string' }, options: { type: 'array' }, validation: { type: 'object' }, sortOrder: { type: 'integer' } } }, response: { 201: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_CHECKLIST_PROFILE', req, reply);
    if (!ok) return;
    const r = await service.addQuestion(buildContext(req), (req.params as any).id, req.body);
    return reply.code(201).send(r);
  });

  app.put('/:id/questions/:questionId', {
    preHandler: [app.requireAnyPermission('FCP_UPDATE', 'CHECKLIST_EDIT')],
    schema: { tags: ['Checklist Questions'], params: { type: 'object', required: ['id', 'questionId'], properties: { id: { type: 'string', format: 'uuid' }, questionId: { type: 'string', format: 'uuid' } } }, body: { type: 'object', properties: { question: { type: 'string' }, questionType: { type: 'string' }, required: { type: 'boolean' }, section: { type: 'string' }, description: { type: 'string' }, options: { type: 'array' }, validation: { type: 'object' }, sortOrder: { type: 'integer' } } }, response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_CHECKLIST_PROFILE', req, reply);
    if (!ok) return;
    return service.updateQuestion(buildContext(req), (req.params as any).id, (req.params as any).questionId, req.body);
  });

  app.delete('/:id/questions/:questionId', {
    preHandler: [app.requireAnyPermission('FCP_DELETE', 'CHECKLIST_DELETE')],
    schema: { tags: ['Checklist Questions'], params: { type: 'object', required: ['id', 'questionId'], properties: { id: { type: 'string', format: 'uuid' }, questionId: { type: 'string', format: 'uuid' } } }, response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_CHECKLIST_PROFILE', req, reply);
    if (!ok) return;
    return service.deleteQuestion(buildContext(req), (req.params as any).id, (req.params as any).questionId);
  });

  app.put('/:id/reorder', {
    preHandler: [app.requireAnyPermission('FCP_UPDATE', 'CHECKLIST_EDIT')],
    schema: { tags: ['Checklist Questions'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', required: ['questionIds'], properties: { questionIds: { type: 'array', items: { type: 'string' } } } }, response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses } },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_CHECKLIST_PROFILE', req, reply);
    if (!ok) return;
    return service.reorderQuestions(buildContext(req), (req.params as any).id, (req.body as any).questionIds);
  });

  // ─── Version history (Phase A.1) ────────────────────────────
  // List historical versions of a profile — cycle audit + offline cache use this.
  app.get('/:id/versions', {
    preHandler: [app.requireAnyPermission('FCP_READ', 'CHECKLIST_TOGGLE', 'VERSION_HISTORY_VIEW')],
    schema: { tags: ['Checklist Profiles'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } }, ...errorResponses } },
  }, async (req) => service.listVersions(buildContext(req), (req.params as any).id));

  // Fetch a specific historical version's full snapshot. Immutable, cacheable forever.
  app.get('/:id/versions/:versionNumber', {
    preHandler: [app.requireAnyPermission('FCP_READ', 'CHECKLIST_TOGGLE', 'VERSION_HISTORY_VIEW')],
    schema: { tags: ['Checklist Profiles'], params: { type: 'object', required: ['id', 'versionNumber'], properties: { id: { type: 'string', format: 'uuid' }, versionNumber: { type: 'integer' } } }, response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses } },
  }, async (req) => service.getVersion(buildContext(req), (req.params as any).id, parseInt((req.params as any).versionNumber, 10)));
}
