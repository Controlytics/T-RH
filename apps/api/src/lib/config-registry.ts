import { z } from 'zod';
import { prisma } from './prisma.js';
import type { RequestContext } from '../types/context.js';

// ─── Setting Field Types ─────────────────────────────────
export type SettingType =
  | 'string' | 'number' | 'boolean' | 'secret'
  | 'select' | 'multiselect' | 'textarea' | 'json'
  | 'color' | 'url' | 'email' | 'cron';

export interface SelectOption {
  value: string | number;
  label: string;
}

export interface ConditionalVisibility {
  field: string;
  value: any;
  operator?: 'eq' | 'neq' | 'in' | 'notIn';
}

export interface SettingDefinition {
  key: string;
  type: SettingType;
  label: string;
  description?: string;
  required?: boolean;
  default?: any;
  placeholder?: string;
  group?: string;
  sortOrder?: number;

  // Type-specific
  options?: SelectOption[];
  /**
   * Relative API URL that returns an array of option-like objects. The frontend
   * config renderer will fetch this and merge the result into `options` at
   * render time. Useful for dropdowns that need a live list from the DB
   * (e.g. roles, users) instead of a hard-coded enum. Supported field mapping:
   *   value ← item.value ?? item.name ?? item.id
   *   label ← item.label ?? item.displayName ?? item.name ?? item.id
   */
  dynamicOptionsSource?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  validation?: string;

  // Security
  maskedInApi?: boolean;

  // Conditional rendering
  visibleWhen?: ConditionalVisibility;

  // UI hints
  width?: 'full' | 'half';
  helpText?: string;
}

// ─── Module Config Definition ────────────────────────────
export interface ModuleConfigDefinition {
  moduleKey: string;
  moduleName: string;
  description: string;
  icon: string;
  category: string;
  sortOrder: number;

  permissions: {
    read: string;
    write: string;
  };
  requiredRole?: string | null;
  requiresReauth: boolean;
  reauthAction?: string | null;

  settings: SettingDefinition[];
  zodSchema?: z.ZodSchema;

  /** If true, this config has a custom frontend page — dynamic page won't render */
  hasCustomPage?: boolean;
  /** Custom frontend route path (e.g., '/config/password-policy') */
  customPagePath?: string;

  hooks?: {
    afterUpdate?: (oldValue: any, newValue: any, ctx: RequestContext) => Promise<void>;
    validate?: (value: any) => Promise<{ valid: boolean; errors?: string[] }>;
    onRead?: (value: any) => any;
  };
}

// ─── Manifest Entry (sent to frontend, no Zod/hooks) ────
export interface ConfigManifestEntry {
  moduleKey: string;
  moduleName: string;
  description: string;
  icon: string;
  category: string;
  sortOrder: number;
  requiredRole: string | null;
  requiresReauth: boolean;
  hasCustomPage: boolean;
  customPagePath: string | null;
  settings: SettingDefinition[];
}

// ─── Config Registry Singleton ───────────────────────────
class ConfigRegistry {
  private definitions = new Map<string, ModuleConfigDefinition>();

  register(def: ModuleConfigDefinition): void {
    if (this.definitions.has(def.moduleKey)) {
      console.warn(`Config registry: overwriting ${def.moduleKey}`);
    }
    this.definitions.set(def.moduleKey, def);
  }

  getAll(): ModuleConfigDefinition[] {
    return [...this.definitions.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  get(moduleKey: string): ModuleConfigDefinition | undefined {
    return this.definitions.get(moduleKey);
  }

  has(moduleKey: string): boolean {
    return this.definitions.has(moduleKey);
  }

  /** Generate manifest filtered by user role + permissions */
  getManifest(userRole: string, userPermissions: string[]): ConfigManifestEntry[] {
    return this.getAll()
      .filter(def => {
        if (userRole === 'SUPER_ADMIN') return true;
        if (def.requiredRole && def.requiredRole !== userRole) return false;
        return userPermissions.includes(def.permissions.read);
      })
      .map(def => ({
        moduleKey: def.moduleKey,
        moduleName: def.moduleName,
        description: def.description,
        icon: def.icon,
        category: def.category,
        sortOrder: def.sortOrder,
        requiredRole: def.requiredRole ?? null,
        requiresReauth: def.requiresReauth,
        hasCustomPage: def.hasCustomPage ?? false,
        customPagePath: def.customPagePath ?? null,
        settings: def.settings,
      }));
  }

  /** Ensure all registered configs exist in DB with defaults */
  async seedDefaults(): Promise<void> {
    for (const def of this.getAll()) {
      const existing = await prisma.systemConfig.findUnique({
        where: { configKey: def.moduleKey },
      });
      if (!existing) {
        const defaults: Record<string, any> = {};
        for (const s of def.settings) {
          if (s.default !== undefined) defaults[s.key] = s.default;
        }
        await prisma.systemConfig.create({
          data: {
            configKey: def.moduleKey,
            configValue: defaults,
            configType: def.category,
            requiresReauth: def.requiresReauth,
          },
        });
        console.info(`Config registry: seeded defaults for ${def.moduleKey}`);
      }
    }
  }

  get size(): number {
    return this.definitions.size;
  }
}

export const configRegistry = new ConfigRegistry();
