import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { Prisma } from '@prisma/client';
import { errorResponses } from '../../lib/error-schemas.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';

export default async function helpRoutes(app: FastifyInstance) {
  // GET /api/help — List help articles (CONFIG_READ; only the SUPER_ADMIN help-manager page consumes it)
  app.get('/', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Help'],
      summary: 'List help articles',
      description: 'Retrieve all active help articles, optionally filtered by category or search term. Ordered by category and sort order.',
      querystring: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category' },
          search: { type: 'string', description: 'Search in title and content' },
        },
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              key: { type: 'string' },
              title: { type: 'string' },
              category: { type: 'string' },
              sortOrder: { type: 'integer' },
              currentVersion: { type: 'integer' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { category, search } = req.query as { category?: string; search?: string };

    const where: Prisma.HelpArticleWhereInput = { isActive: true };

    if (category) {
      where.category = category;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { content: { contains: search, mode: 'insensitive' } },
      ];
    }

    const articles = await prisma.helpArticle.findMany({
      where,
      select: {
        id: true,
        key: true,
        title: true,
        category: true,
        sortOrder: true,
        currentVersion: true,
        updatedAt: true,
      },
      orderBy: [
        { category: 'asc' },
        { sortOrder: 'asc' },
      ],
    });

    return articles;
  });

  // GET /api/help/:key — Get article by context key (CONFIG_READ; SUPER_ADMIN help-manager page only)
  app.get('/:key', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Help'],
      summary: 'Get help article by key',
      description: 'Retrieve a single active help article by its unique context key.',
      params: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string', description: 'Unique article key' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            key: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
            category: { type: 'string' },
            currentVersion: { type: 'integer' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { key } = req.params as { key: string };

    const article = await prisma.helpArticle.findFirst({
      where: { key, isActive: true },
      select: {
        id: true,
        key: true,
        title: true,
        content: true,
        category: true,
        currentVersion: true,
        updatedAt: true,
      },
    });

    if (!article) {
      return reply.code(404).send({ error: 'Help article not found' });
    }

    return article;
  });

  // POST /api/help — Create help article (SUPER_ADMIN only)
  app.post('/', {
    preHandler: [app.requireRole('SUPER_ADMIN')],
    schema: {
      tags: ['Help'],
      summary: 'Create help article',
      description: 'Create a new help article with an initial version snapshot. Requires SUPER_ADMIN role.',
      body: {
        type: 'object',
        required: ['key', 'title', 'content', 'category'],
        properties: {
          key: { type: 'string', maxLength: 100, description: 'Unique context key for the article' },
          title: { type: 'string', maxLength: 200, description: 'Article title' },
          content: { type: 'string', description: 'Article content (supports markdown/HTML)' },
          category: { type: 'string', maxLength: 50, description: 'Article category' },
          sortOrder: { type: 'integer', default: 0, description: 'Sort order within category' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            key: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
            category: { type: 'string' },
            sortOrder: { type: 'integer' },
            currentVersion: { type: 'integer' },
            isActive: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_HELP_ARTICLE', req, reply);
    if (!ok) return;

    const user = (req as any).user as { id: string; username: string; role: string };
    const { key, title, content, category, sortOrder } = req.body as {
      key: string;
      title: string;
      content: string;
      category: string;
      sortOrder?: number;
    };

    // Check key uniqueness
    const existing = await prisma.helpArticle.findUnique({ where: { key } });
    if (existing) {
      return reply.code(409).send({ error: `Help article with key "${key}" already exists` });
    }

    const article = await prisma.$transaction(async (tx) => {
      const created = await tx.helpArticle.create({
        data: {
          key,
          title,
          content,
          category,
          sortOrder: sortOrder ?? 0,
          currentVersion: 1,
        },
      });

      await tx.helpArticleVersion.create({
        data: {
          helpArticleId: created.id,
          version: 1,
          content,
          changedBy: user.username,
          changeNotes: 'Initial version',
        },
      });

      return created;
    });

    await auditLog({
      userId: user.username, userRole: user.role, action: 'HELP_ARTICLE_CREATED',
      targetType: 'help_article', targetId: article.id,
      afterValue: { key, title, category },
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });

    return reply.code(201).send(article);
  });

  // PUT /api/help/:id — Update help article (SUPER_ADMIN only, creates new version)
  app.put('/:id', {
    preHandler: [app.requireRole('SUPER_ADMIN')],
    schema: {
      tags: ['Help'],
      summary: 'Update help article',
      description: 'Update a help article and create a new version snapshot. Requires SUPER_ADMIN role.',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Article UUID' },
        },
      },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 200, description: 'Updated title' },
          content: { type: 'string', description: 'Updated content' },
          category: { type: 'string', maxLength: 50, description: 'Updated category' },
          sortOrder: { type: 'integer', description: 'Updated sort order' },
          isActive: { type: 'boolean', description: 'Enable or disable the article' },
          changeNotes: { type: 'string', maxLength: 200, description: 'Notes describing the change' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            key: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
            category: { type: 'string' },
            sortOrder: { type: 'integer' },
            currentVersion: { type: 'integer' },
            isActive: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_HELP_ARTICLE', req, reply);
    if (!ok) return;

    const user = (req as any).user as { id: string; username: string; role: string };
    const { id } = req.params as { id: string };
    const { title, content, category, sortOrder, isActive, changeNotes } = req.body as {
      title?: string;
      content?: string;
      category?: string;
      sortOrder?: number;
      isActive?: boolean;
      changeNotes?: string;
    };

    const existing = await prisma.helpArticle.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: 'Help article not found' });
    }

    const newVersion = existing.currentVersion + 1;

    const updated = await prisma.$transaction(async (tx) => {
      // Create new version snapshot
      await tx.helpArticleVersion.create({
        data: {
          helpArticleId: id,
          version: newVersion,
          content: content ?? existing.content,
          changedBy: user.username,
          changeNotes: changeNotes ?? null,
        },
      });

      // Update article fields
      const article = await tx.helpArticle.update({
        where: { id },
        data: {
          ...(title !== undefined && { title }),
          ...(content !== undefined && { content }),
          ...(category !== undefined && { category }),
          ...(sortOrder !== undefined && { sortOrder }),
          ...(isActive !== undefined && { isActive }),
          currentVersion: newVersion,
        },
      });

      return article;
    });

    await auditLog({
      userId: user.username, userRole: user.role, action: 'HELP_ARTICLE_UPDATED',
      targetType: 'help_article', targetId: id,
      beforeValue: { title: existing.title, category: existing.category },
      afterValue: { title: updated.title, category: updated.category, version: updated.currentVersion },
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });

    return updated;
  });

  // GET /api/help/:id/versions — Get version history (SUPER_ADMIN or ADMIN)
  app.get('/:id/versions', {
    preHandler: [app.requireRole('SUPER_ADMIN', 'ADMIN')],
    schema: {
      tags: ['Help'],
      summary: 'Get article version history',
      description: 'Retrieve all version snapshots for a help article, ordered by version descending. Requires SUPER_ADMIN or ADMIN role.',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Article UUID' },
        },
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              helpArticleId: { type: 'string' },
              version: { type: 'integer' },
              content: { type: 'string' },
              changedBy: { type: 'string' },
              changeNotes: { type: 'string', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };

    const versions = await prisma.helpArticleVersion.findMany({
      where: { helpArticleId: id },
      orderBy: { version: 'desc' },
    });

    return versions;
  });

  // DELETE /api/help/:id — Soft delete help article (SUPER_ADMIN only)
  app.delete('/:id', {
    preHandler: [app.requireRole('SUPER_ADMIN')],
    schema: {
      tags: ['Help'],
      summary: 'Delete help article',
      description: 'Soft delete a help article by setting isActive to false. Requires SUPER_ADMIN role.',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Article UUID' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            deleted: { type: 'boolean' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_HELP_ARTICLE', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const user = (req as any).user as { username: string; role: string };

    const existing = await prisma.helpArticle.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: 'Help article not found' });
    }

    await prisma.helpArticle.update({
      where: { id },
      data: { isActive: false },
    });

    await auditLog({
      userId: user.username, userRole: user.role, action: 'HELP_ARTICLE_DELETED',
      targetType: 'help_article', targetId: id,
      beforeValue: { key: existing.key, title: existing.title },
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    });

    return { deleted: true };
  });
}
