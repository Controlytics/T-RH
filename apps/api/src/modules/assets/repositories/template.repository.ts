import { prisma } from '../../../lib/prisma.js';

export const templateRepository = {
  async findMany(where: Record<string, unknown>, page: number, limit?: number) {
    // Sort order: active templates first, then ones that actually have
    // live instances (descending), then most-recently-created. This keeps
    // the "real" production templates (Block/Filter/AHU/Area, all of which
    // have many active instances) at the top of the list and pushes
    // unused-but-not-deleted e2e fixture templates (which accumulate over
    // testing and dominate `createdAt DESC` ordering) to the bottom.
    const [templates, total] = await Promise.all([
      prisma.assetTemplate.findMany({
        where: where as any,
        include: { _count: { select: { instances: { where: { isActive: true } } } } },
        orderBy: [
          { isActive: 'desc' },
          { instances: { _count: 'desc' } },
          { createdAt: 'desc' },
        ],
        ...(limit ? { skip: (page - 1) * limit, take: limit } : {}),
      }),
      prisma.assetTemplate.count({ where: where as any }),
    ]);
    return { templates, total };
  },

  async findById(id: string) {
    return prisma.assetTemplate.findUnique({
      where: { id },
      include: { _count: { select: { instances: { where: { isActive: true } } } } },
    });
  },

  async findByName(name: string) {
    return prisma.assetTemplate.findUnique({ where: { name } });
  },

  async create(data: {
    name: string;
    description?: string;
    category?: string;
    icon?: string;
    templateKind?: 'BLOCK' | 'AREA' | 'AHU' | 'FILTER' | 'EQUIPMENT' | 'OTHER';
    attributeSchema?: any;
    telemetrySchema?: any;
    expectedIdentifiers?: any;
    expectedRelationships?: any;
    statusLifecycle?: any;
    checklistSchema?: any;
    maxParentConnections?: number;
    maxConnections?: number;
    dataIngestionEnabled?: boolean;
    transportType?: string | null;
    credentialType?: string;
    inactivityTimeout?: number;
    defaultMaxDataRate?: number;
    autoProvision?: boolean;
    createdBy: string;
  }) {
    return prisma.assetTemplate.create({
      data: {
        name: data.name,
        description: data.description,
        category: data.category,
        icon: data.icon,
        templateKind: data.templateKind,
        version: 1,
        attributeSchema: data.attributeSchema as any,
        telemetrySchema: data.telemetrySchema as any,
        expectedIdentifiers: data.expectedIdentifiers as any,
        expectedRelationships: data.expectedRelationships as any,
        statusLifecycle: data.statusLifecycle as any,
        checklistSchema: data.checklistSchema as any,
        maxParentConnections: data.maxParentConnections ?? 1,
        maxConnections: data.maxConnections ?? 10,
        dataIngestionEnabled: data.dataIngestionEnabled ?? false,
        transportType: data.transportType,
        credentialType: data.credentialType ?? 'TOKEN',
        inactivityTimeout: data.inactivityTimeout ?? 60,
        defaultMaxDataRate: data.defaultMaxDataRate ?? 600,
        autoProvision: data.autoProvision ?? true,
        createdBy: data.createdBy,
      },
    });
  },

  async update(id: string, data: Record<string, unknown>) {
    return prisma.assetTemplate.update({ where: { id }, data: data as any });
  },

  async softDelete(id: string, username: string) {
    return prisma.assetTemplate.update({
      where: { id },
      data: { isActive: false, updatedBy: username },
    });
  },

  async createVersion(data: {
    templateId: string;
    versionNumber: number;
    snapshot: any;
    changeNotes: string;
    createdBy: string;
  }) {
    return prisma.assetTemplateVersion.create({ data });
  },

  async findVersions(templateId: string) {
    return prisma.assetTemplateVersion.findMany({
      where: { templateId },
      orderBy: { versionNumber: 'desc' },
    });
  },

  /**
   * Step 4 (2026-05-02): list FilterProfile rows that bind this template via
   * the `filter_profile_applicable_templates` join table. Used by the delete
   * guard in the service layer to return a useful 409 IN_USE before relying
   * on the cascade FK. Lives in the repo (not the service) so the service
   * stays mockable in unit tests.
   */
  async findFilterProfileBindings(templateId: string) {
    return prisma.filterProfileApplicableTemplate.findMany({
      where: { templateId },
      include: { profile: { select: { id: true, name: true } } },
    });
  },
};
