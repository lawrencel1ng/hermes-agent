/**
 * Platform Health API
 * GET: Get health status for all platforms or specific tenant
 * POST: Control health monitoring (start/stop)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { 
  getAllPlatformHealth, 
  getPlatformHealth, 
  getPlatformHealthHistory,
  getAggregatedMetrics,
  getPlatformComparison,
  startHealthMonitoring,
  stopHealthMonitoring,
  startAllHealthMonitoring,
  stopAllHealthMonitoring
} from '$lib/services/voice/platformHealthMonitor.js';
import { logger } from '$lib/utils/logger.js';

// GET /api/voice/platform/health
export const GET: RequestHandler = async ({ url, locals }) => {
  try {
    if (!locals.user) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const requestedTenantId = url.searchParams.get('tenantId');
    const history = url.searchParams.get('history') === 'true';
    const hours = parseInt(url.searchParams.get('hours') || '24');
    const aggregate = url.searchParams.get('aggregate') === 'true';
    const compare = url.searchParams.get('compare') === 'true';

    const userRoles = locals.user.roles || [];
    const isAdmin = userRoles.includes('Admin') || userRoles.includes('Super Admin');

    // SECURITY: Determine effective tenant ID
    // - If no tenantId requested, use user's tenant
    // - If tenantId requested and user is admin, allow it
    // - If tenantId requested and user is NOT admin, only allow if it matches user's tenant
    let effectiveTenantId: string;
    
    if (requestedTenantId) {
      if (requestedTenantId !== locals.user.tenantId && !isAdmin) {
        return json({ error: 'Forbidden - cannot access other tenant health data' }, { status: 403 });
      }
      effectiveTenantId = requestedTenantId;
    } else {
      effectiveTenantId = locals.user.tenantId;
    }

    // If aggregate requested, return aggregated metrics for the tenant
    if (aggregate) {
      const metrics = await getAggregatedMetrics(effectiveTenantId);
      return json({ success: true, data: metrics });
    }

    // If compare requested, return platform comparison for the tenant
    if (compare) {
      const comparison = await getPlatformComparison(effectiveTenantId);
      return json({ success: true, data: comparison });
    }

    // If tenantId provided, return specific tenant health
    if (requestedTenantId) {
      if (history) {
        const healthHistory = await getPlatformHealthHistory(effectiveTenantId, hours);
        return json({ success: true, data: { history: healthHistory } });
      }

      const health = await getPlatformHealth(effectiveTenantId);
      if (!health) {
        return json({ error: 'Platform health not found' }, { status: 404 });
      }
      return json({ success: true, data: health });
    }

    // Return all platform health for the user's tenant only
    const allHealth = await getAllPlatformHealth(effectiveTenantId);
    return json({ success: true, data: allHealth });

  } catch (error) {
    logger.error('Failed to get platform health', error instanceof Error ? error : new Error(String(error)));
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};

// POST /api/voice/platform/health - Control monitoring
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check admin role
    if (!locals.user.roles?.includes('Admin')) {
      return json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { action, tenantId, config } = body;

    switch (action) {
      case 'start':
        if (tenantId) {
          await startHealthMonitoring(tenantId, config);
          return json({ success: true, message: `Started monitoring for ${tenantId}` });
        } else {
          await startAllHealthMonitoring();
          return json({ success: true, message: 'Started monitoring for all platforms' });
        }

      case 'stop':
        if (tenantId) {
          stopHealthMonitoring(tenantId);
          return json({ success: true, message: `Stopped monitoring for ${tenantId}` });
        } else {
          stopAllHealthMonitoring();
          return json({ success: true, message: 'Stopped monitoring for all platforms' });
        }

      default:
        return json({ error: 'Invalid action' }, { status: 400 });
    }

  } catch (error) {
    logger.error('Failed to control health monitoring', error instanceof Error ? error : new Error(String(error)));
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};
