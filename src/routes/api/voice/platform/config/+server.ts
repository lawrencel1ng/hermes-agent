/**
 * Platform Configuration API
 * GET: Get configuration for a tenant's platform
 * POST: Update configuration
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { 
  getPlatformConfiguration, 
  updatePlatformConfiguration,
  getConfigAuditTrail,
  validateAllConfigurations,
  bulkUpdateConfigurations,
  startConfigWatcher,
  stopConfigWatcher
} from '$lib/services/voice/platformConfigManager.js';
import { logger } from '$lib/utils/logger.js';

// GET /api/voice/platform/config
export const GET: RequestHandler = async ({ url, locals }) => {
  try {
    if (!locals.user) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const tenantId = url.searchParams.get('tenantId') || locals.user.tenantId;
    const audit = url.searchParams.get('audit') === 'true';
    const validate = url.searchParams.get('validate') === 'true';

    // SECURITY: Validate tenant access - non-admins can only access their own tenant
    const userRoles = locals.user.roles || [];
    const isAdmin = userRoles.includes('Admin') || userRoles.includes('Super Admin');
    if (tenantId !== locals.user.tenantId && !isAdmin) {
      return json({ error: 'Forbidden - cannot access other tenant configurations' }, { status: 403 });
    }

    // If validate requested, validate configurations for the specified tenant only
    if (validate) {
      const validations = await validateAllConfigurations(tenantId);
      return json({ success: true, data: validations });
    }

    // If audit requested, return audit trail
    if (audit) {
      const auditTrail = await getConfigAuditTrail(tenantId);
      return json({ success: true, data: auditTrail });
    }

    // Get configuration
    const config = await getPlatformConfiguration(tenantId);
    if (!config) {
      return json({ error: 'Platform configuration not found' }, { status: 404 });
    }

    return json({ success: true, data: config });

  } catch (error) {
    logger.error('Failed to get platform configuration', error instanceof Error ? error : new Error(String(error)));
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};

// POST /api/voice/platform/config - Update configuration
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { action, tenantId, updates, bulk } = body;

    switch (action) {
      case 'update': {
        const targetTenantId = tenantId || locals.user.tenantId;
        
        // Check permissions
        if (targetTenantId !== locals.user.tenantId && !locals.user.roles?.includes('Admin')) {
          return json({ error: 'Forbidden' }, { status: 403 });
        }

        const result = await updatePlatformConfiguration(
          targetTenantId,
          updates,
          locals.user.email || locals.user.username
        );

        if (result.success) {
          return json({ success: true, message: 'Configuration updated successfully' });
        } else {
          return json({ error: result.error }, { status: 400 });
        }
      }

      case 'bulkUpdate': {
        // Only admins can do bulk updates
        if (!locals.user.roles?.includes('Admin')) {
          return json({ error: 'Forbidden' }, { status: 403 });
        }

        if (!Array.isArray(bulk)) {
          return json({ error: 'Invalid bulk update format' }, { status: 400 });
        }

        const result = await bulkUpdateConfigurations(
          bulk,
          locals.user.email || locals.user.username
        );

        return json({ 
          success: true, 
          data: {
            success: result.success,
            failed: result.failed,
            errors: result.errors
          }
        });
      }

      case 'startWatcher': {
        const targetTenantId = tenantId || locals.user.tenantId;
        // SECURITY: Validate tenant access
        if (targetTenantId !== locals.user.tenantId && !locals.user.roles?.includes('Admin')) {
          return json({ error: 'Forbidden - cannot access other tenant configurations' }, { status: 403 });
        }
        await startConfigWatcher(targetTenantId);
        return json({ success: true, message: `Started config watcher for ${targetTenantId}` });
      }

      case 'stopWatcher': {
        const targetTenantId = tenantId || locals.user.tenantId;
        // SECURITY: Validate tenant access
        if (targetTenantId !== locals.user.tenantId && !locals.user.roles?.includes('Admin')) {
          return json({ error: 'Forbidden - cannot access other tenant configurations' }, { status: 403 });
        }
        stopConfigWatcher(targetTenantId);
        return json({ success: true, message: `Stopped config watcher for ${targetTenantId}` });
      }

      default:
        return json({ error: 'Invalid action' }, { status: 400 });
    }

  } catch (error) {
    logger.error('Failed to update platform configuration', error instanceof Error ? error : new Error(String(error)));
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};
