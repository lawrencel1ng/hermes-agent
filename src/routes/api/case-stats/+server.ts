/**
 * Case Statistics API
 *
 * GET /api/case-stats - Get comprehensive case statistics for the tenant
 *
 * Returns:
 * - totalCases: Total cases in the system
 * - openCases: Currently open cases
 * - closedCases: Resolved/closed cases
 * - casesByStatus: Breakdown by status
 * - casesByPriority: Breakdown by priority
 * - slaComplianceRate: Percentage of cases meeting SLA
 * - avgResolutionTimeHours: Average time to resolution
 * - casesCreatedToday: New cases today
 * - casesResolvedToday: Cases closed today
 * - escalationRate: Percentage of escalated cases
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { query } from '$lib/server/db.js';
import { getTenantId } from '$lib/server/tenant.js';
import { getUserFromRequest } from '$lib/server/auth.js';
import { logger } from '$lib/utils/logger.js';
import { getFollowUpReminderStats } from '$lib/services/caseFollowUpReminderService.js';

export const GET: RequestHandler = async ({ request, url }) => {
  let user: any = null;
  let tenantId: string | null = null;

  try {
    user = await getUserFromRequest(request);
    if (!user) {
      throw error(401, 'Unauthorized');
    }

    const rolesResult = await query(
      `SELECT r.name FROM roles r
       JOIN user_roles ur ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [user.id]
    );
    const roles = rolesResult.rows.map(r => r.name);

    tenantId = getTenantId(request, user.tenantId, roles);
    if (!tenantId) {
      throw error(400, 'Tenant ID required');
    }

    // Parse optional date range filters
    const daysBack = parseInt(url.searchParams.get('days') || '30', 10);
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - daysBack);

    // Get basic counts
    const countsResult = await query(
      `SELECT
        COUNT(*) as total_cases,
        COUNT(*) FILTER (WHERE status NOT IN ('Closed', 'Cancelled', 'Resolved')) as open_cases,
        COUNT(*) FILTER (WHERE status IN ('Closed', 'Resolved')) as closed_cases,
        COUNT(*) FILTER (WHERE status = 'Escalated') as escalated_cases,
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) as cases_created_today,
        COUNT(*) FILTER (WHERE DATE(closed_at) = CURRENT_DATE) as cases_resolved_today
       FROM cases
       WHERE tenant_id = $1
         AND created_at >= $2`,
      [tenantId, sinceDate]
    );

    // Get cases by status
    const statusResult = await query(
      `SELECT status, COUNT(*) as count
       FROM cases
       WHERE tenant_id = $1
         AND created_at >= $2
       GROUP BY status
       ORDER BY count DESC`,
      [tenantId, sinceDate]
    );

    // Get cases by priority
    const priorityResult = await query(
      `SELECT priority, COUNT(*) as count
       FROM cases
       WHERE tenant_id = $1
         AND created_at >= $2
       GROUP BY priority
       ORDER BY count DESC`,
      [tenantId, sinceDate]
    );

    // Get SLA compliance stats
    const slaResult = await query(
      `SELECT
        COUNT(*) FILTER (WHERE sla_status = 'met' OR sla_status = 'on_track') as sla_met,
        COUNT(*) FILTER (WHERE sla_status = 'breached' OR sla_status = 'overdue') as sla_breached,
        COUNT(*) FILTER (WHERE sla_status IS NOT NULL) as total_with_sla
       FROM cases
       WHERE tenant_id = $1
         AND created_at >= $2`,
      [tenantId, sinceDate]
    );

    // Get average resolution time for resolved cases
    const resolutionResult = await query(
      `SELECT
        AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 3600) as avg_resolution_hours,
        AVG(EXTRACT(EPOCH FROM (resolved_on - created_at)) / 3600) as avg_resolve_to_close_hours
       FROM cases
       WHERE tenant_id = $1
         AND status IN ('Closed', 'Resolved')
         AND created_at >= $2
         AND closed_at IS NOT NULL`,
      [tenantId, sinceDate]
    );

    // Get CSAT statistics for resolved cases
    const csatResult = await query(
      `SELECT
        COUNT(*) FILTER (WHERE csat_score IS NOT NULL) as total_responses,
        AVG(csat_score) as avg_score,
        COUNT(*) FILTER (WHERE csat_score >= 4) as satisfied_count,
        COUNT(*) FILTER (WHERE csat_score = 3) as neutral_count,
        COUNT(*) FILTER (WHERE csat_score <= 2) as dissatisfied_count
       FROM cases
       WHERE tenant_id = $1
         AND status IN ('Closed', 'Resolved')
         AND created_at >= $2`,
      [tenantId, sinceDate]
    );

    // Get recent activity trend (last 7 days)
    const trendResult = await query(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) as created,
        COUNT(*) FILTER (WHERE status IN ('Closed', 'Resolved')) as closed
       FROM cases
       WHERE tenant_id = $1
         AND created_at >= CURRENT_DATE - INTERVAL '7 days'
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [tenantId]
    );

    const counts = countsResult.rows[0];
    const sla = slaResult.rows[0];
    const resolution = resolutionResult.rows[0];
    const csat = csatResult.rows[0];
    const followUpStats = await getFollowUpReminderStats(tenantId);

    const totalWithSla = parseInt(sla.total_with_sla) || 0;
    const slaMet = parseInt(sla.sla_met) || 0;
    const totalCases = parseInt(counts.total_cases) || 0;
    const escalatedCases = parseInt(counts.escalated_cases) || 0;
    const totalCsatResponses = parseInt(csat.total_responses) || 0;
    const satisfiedCount = parseInt(csat.satisfied_count) || 0;

    const stats = {
      period: {
        days: daysBack,
        since: sinceDate.toISOString()
      },
      counts: {
        totalCases,
        openCases: parseInt(counts.open_cases) || 0,
        closedCases: parseInt(counts.closed_cases) || 0,
        escalatedCases,
        casesCreatedToday: parseInt(counts.cases_created_today) || 0,
        casesResolvedToday: parseInt(counts.cases_resolved_today) || 0
      },
      byStatus: statusResult.rows.reduce((acc, row) => {
        acc[row.status] = parseInt(row.count);
        return acc;
      }, {} as Record<string, number>),
      byPriority: priorityResult.rows.reduce((acc, row) => {
        acc[row.priority] = parseInt(row.count);
        return acc;
      }, {} as Record<string, number>),
      sla: {
        complianceRate: totalWithSla > 0 ? Math.round((slaMet / totalWithSla) * 100) : 100,
        met: slaMet,
        breached: parseInt(sla.sla_breached) || 0,
        totalWithSla
      },
      csat: {
        totalResponses: totalCsatResponses,
        averageScore: totalCsatResponses > 0 ? Math.round((parseFloat(csat.avg_score) || 0) * 10) / 10 : null,
        satisfactionRate: totalCsatResponses > 0 ? Math.round((satisfiedCount / totalCsatResponses) * 100) : null,
        distribution: {
          satisfied: satisfiedCount,
          neutral: parseInt(csat.neutral_count) || 0,
          dissatisfied: parseInt(csat.dissatisfied_count) || 0
        }
      },
      followUps: {
        overdue: followUpStats.overdue,
        dueToday: followUpStats.dueToday,
        upcoming: followUpStats.upcoming
      },
      performance: {
        avgResolutionTimeHours: Math.round((parseFloat(resolution.avg_resolution_hours) || 0) * 10) / 10,
        avgTimeToResolveHours: Math.round((parseFloat(resolution.avg_resolve_to_close_hours) || 0) * 10) / 10,
        escalationRate: totalCases > 0 ? Math.round((escalatedCases / totalCases) * 100) : 0
      },
      trend: trendResult.rows.map(row => ({
        date: row.date,
        created: parseInt(row.created),
        closed: parseInt(row.closed)
      }))
    };

    logger.info('Case stats retrieved', {
      tenantId,
      totalCases,
      daysBack,
      followUpsOverdue: followUpStats.overdue
    }, { tenantId, source: 'case-stats-api' });

    return json({
      success: true,
      data: stats
    });

  } catch (err: any) {
    logger.error(
      'Error fetching case stats',
      err instanceof Error ? err : new Error(String(err)),
      { tenantId },
      {
        source: 'case-stats-api',
        tenantId: tenantId || undefined,
        userId: user?.id
      }
    );

    if (err.status) {
      throw err;
    }

    throw error(500, 'Internal server error');
  }
};
