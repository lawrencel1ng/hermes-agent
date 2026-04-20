import { json } from '@sveltejs/kit';
import { query } from '$lib/server/db.js';
import { logger } from '$lib/utils/logger.js';
import type { RequestHandler } from './$types.js';

// GET /api/cases/tags - List all tags for tenant with usage counts
export const GET: RequestHandler = async ({ locals }) => {
  try {
    if (!locals.user) {
      return new Response('Unauthorized', { status: 401 });
    }

    const result = await query(
      `SELECT 
        t.id, 
        t.name, 
        t.color,
        COUNT(DISTINCT ctm.case_id) FILTER (WHERE c.status NOT IN ('Closed', 'Resolved', 'Cancelled')) as open_case_count,
        COUNT(DISTINCT ctm.case_id) as total_case_count
      FROM case_tags t
      LEFT JOIN case_tag_mappings ctm ON t.id = ctm.tag_id
      LEFT JOIN cases c ON ctm.case_id = c.id
      WHERE t.tenant_id = $1
      GROUP BY t.id, t.name, t.color
      ORDER BY t.name`,
      [locals.user.tenantId]
    );

    return json({ 
      success: true, 
      data: result.rows.map(row => ({
        id: row.id,
        name: row.name,
        color: row.color,
        openCaseCount: parseInt(row.open_case_count, 10) || 0,
        totalCaseCount: parseInt(row.total_case_count, 10) || 0
      }))
    });
  } catch (error) {
    logger.error('Failed to fetch tags', error instanceof Error ? error : new Error(String(error)));
    return json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/cases/tags - Create a new tag
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) {
      return new Response('Unauthorized', { status: 401 });
    }

    const { name, color = '#3B82F6' } = await request.json();

    if (!name || name.trim().length === 0) {
      return json({ error: 'Tag name is required' }, { status: 400 });
    }

    // Check if tag already exists
    const existing = await query(
      'SELECT id FROM case_tags WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)',
      [locals.user.tenantId, name.trim()]
    );

    if (existing.rows.length > 0) {
      return json({ error: 'Tag already exists' }, { status: 409 });
    }

    const result = await query(
      'INSERT INTO case_tags (tenant_id, name, color) VALUES ($1, $2, $3) RETURNING id, name, color',
      [locals.user.tenantId, name.trim(), color],
      request
    );

    return json({ success: true, data: result.rows[0] }, { status: 201 });
  } catch (error) {
    logger.error('Failed to create tag', error instanceof Error ? error : new Error(String(error)));
    return json({ error: 'Internal server error' }, { status: 500 });
  }
}
