/**
 * Portal Voice Features Page Server
 * Validates tenant has a voice platform before rendering voice-specific UI
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { query } from '$lib/server/db.js';
import { logger } from '$lib/utils/logger.js';

export const load: PageServerLoad = async ({ request, cookies }) => {
  // Get session token from cookies or header
  const sessionToken = cookies.get('portal_session') ?? request.headers.get('X-Portal-Session');

  if (!sessionToken) {
    throw redirect(302, '/portal/auth/login');
  }

  try {
    // Validate portal session
    const sessionResult = await query(`
      SELECT ps.contact_id, ps.tenant_id
      FROM portal_sessions ps
      WHERE ps.session_token = $1
        AND ps.expires_at > NOW()
    `, [sessionToken]);

    if (sessionResult.rows.length === 0) {
      throw redirect(302, '/portal/auth/login');
    }

    const { tenant_id: tenantId } = sessionResult.rows[0];

    // CRITICAL: Verify tenant has an active voice platform configured
    const platformResult = await query(
      `SELECT platform, is_active
       FROM tenant_platform_configs
       WHERE tenant_id = $1 AND is_active = true AND supports_voice = true
       LIMIT 1`,
      [tenantId]
    );

    if (platformResult.rows.length === 0) {
      logger.warning('Portal voice-features accessed without voice platform configured', {
        tenantId
      }, { source: 'portal/voice-features' });
      throw redirect(302, '/portal?error=voice_not_configured');
    }

    return {
      platform: platformResult.rows[0].platform,
      isActive: platformResult.rows[0].is_active,
      tenantId
    };
  } catch (err: any) {
    if (err?.status === 302 || err?.location) throw err;
    logger.error('Failed to validate voice platform for portal voice-features', err, { source: 'portal/voice-features' });
    throw redirect(302, '/portal?error=voice_validation_failed');
  }
};