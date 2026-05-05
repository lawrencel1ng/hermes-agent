/**
 * Platform Configuration Manager
 * 
 * Hot-reloadable configuration for voice platforms:
 * - Watch for configuration changes
 * - Reload without restart
 * - Configuration validation
 * - Rollback on failure
 * - Audit trail for config changes
 * 
 * @module services/voice/platformConfigManager
 */

import { query } from '$lib/server/db.js';
import { logger } from '$lib/utils/logger.js';
import { EventEmitter } from 'events';
import { clearPlatformVoiceProviderCache } from './platformVoiceAdapter.js';

export interface PlatformConfiguration {
  tenantId: string;
  platform: string;
  apiBaseUrl?: string;
  authType: string;
  orgId?: string;
  region?: string;
  instanceId?: string;
  supportsVoice: boolean;
  supportsChat: boolean;
  supportsEmail: boolean;
  supportsSMS: boolean;
  isActive: boolean;
  settings: Record<string, unknown>;
  updatedAt: Date;
}

interface ConfigChangeEvent {
  tenantId: string;
  platform: string;
  previousConfig: PlatformConfiguration | null;
  newConfig: PlatformConfiguration;
  changedBy: string;
  changedAt: Date;
}

// Event emitter for config changes
const configEmitter = new EventEmitter();

// Last known configuration hash (to detect changes)
const configHashMap = new Map<string, string>();

// Active watchers
const activeWatchers = new Map<string, NodeJS.Timeout>();

/**
 * Get configuration for a tenant's platform
 * CRITICAL FIX: Added optional platform filter and deterministic ordering
 * to prevent cross-platform leakage when a tenant has multiple platforms.
 */
export async function getPlatformConfiguration(tenantId: string, platform?: string): Promise<PlatformConfiguration | null> {
  const params: string[] = [tenantId];
  let whereClause = 'tpc.tenant_id = $1 AND tpc.is_active = true';

  if (platform) {
    whereClause += ' AND tpc.platform = $2';
    params.push(platform);
  }

  const result = await query(
    `SELECT
      tpc.tenant_id,
      tpc.platform,
      tpc.api_base_url,
      tpc.auth_type,
      tpc.org_id,
      tpc.region,
      tpc.instance_id,
      tpc.supports_voice,
      tpc.supports_chat,
      tpc.supports_email,
      tpc.supports_sms,
      tpc.is_active,
      tpc.updated_at,
      COALESCE(tpc.config, '{}') as settings
    FROM tenant_platform_configs tpc
    WHERE ${whereClause}
    ORDER BY tpc.platform`,
    params
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  
  return {
    tenantId: row.tenant_id,
    platform: row.platform,
    apiBaseUrl: row.api_base_url,
    authType: row.auth_type,
    orgId: row.org_id,
    region: row.region,
    instanceId: row.instance_id,
    supportsVoice: row.supports_voice,
    supportsChat: row.supports_chat,
    supportsEmail: row.supports_email,
    supportsSMS: row.supports_sms,
    isActive: row.is_active,
    settings: row.settings,
    updatedAt: row.updated_at,
  };
}

/**
 * Update configuration for a tenant's platform
 */
export async function updatePlatformConfiguration(
  tenantId: string,
  updates: Partial<PlatformConfiguration>,
  changedBy: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get current config for audit trail
    const currentConfig = await getPlatformConfiguration(tenantId);
    
    if (!currentConfig) {
      return { success: false, error: 'Platform configuration not found' };
    }

    // Validate updates
    const validation = validateConfiguration(updates);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // Build update query
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.apiBaseUrl !== undefined) {
      setClauses.push(`api_base_url = $${paramIndex++}`);
      values.push(updates.apiBaseUrl);
    }

    if (updates.region !== undefined) {
      setClauses.push(`region = $${paramIndex++}`);
      values.push(updates.region);
    }

    if (updates.instanceId !== undefined) {
      setClauses.push(`instance_id = $${paramIndex++}`);
      values.push(updates.instanceId);
    }

    if (updates.supportsVoice !== undefined) {
      setClauses.push(`supports_voice = $${paramIndex++}`);
      values.push(updates.supportsVoice);
    }

    if (updates.supportsChat !== undefined) {
      setClauses.push(`supports_chat = $${paramIndex++}`);
      values.push(updates.supportsChat);
    }

    if (updates.supportsEmail !== undefined) {
      setClauses.push(`supports_email = $${paramIndex++}`);
      values.push(updates.supportsEmail);
    }

    if (updates.supportsSMS !== undefined) {
      setClauses.push(`supports_sms = $${paramIndex++}`);
      values.push(updates.supportsSMS);
    }

    if (updates.settings !== undefined) {
      setClauses.push(`config = $${paramIndex++}`);
      values.push(JSON.stringify(updates.settings));
    }

    // Always update the updated_at timestamp
    setClauses.push(`updated_at = NOW()`);

    if (setClauses.length === 0) {
      return { success: false, error: 'No valid updates provided' };
    }

    // Add tenant_id and platform to values
    values.push(tenantId);
    values.push(currentConfig.platform);

    // Execute update - CRITICAL FIX: scope to specific platform to prevent
    // cross-platform data corruption within the same tenant. Previously this
    // updated ALL platform configs for the tenant, leaking settings between
    // Amazon Connect, Cisco Webex, Genesys, FreeSWITCH, etc.
    await query(
      `UPDATE tenant_platform_configs
       SET ${setClauses.join(', ')}
       WHERE tenant_id = $${paramIndex} AND platform = $${paramIndex + 1}`,
      values
    );

    // Clear provider cache to force reload
    clearPlatformVoiceProviderCache(tenantId);

    // Get updated config - scoped to the specific platform to ensure
    // we return the config we just updated, not another platform's config
    const newConfig = await getPlatformConfiguration(tenantId, currentConfig.platform);

    // Log to audit trail
    await query(
      `INSERT INTO platform_config_audit (
        tenant_id, platform, previous_config, new_config, changed_by, changed_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        tenantId,
        currentConfig.platform,
        JSON.stringify(currentConfig),
        JSON.stringify(newConfig),
        changedBy,
      ]
    );

    // Emit change event
    const changeEvent: ConfigChangeEvent = {
      tenantId,
      platform: currentConfig.platform,
      previousConfig: currentConfig,
      newConfig: newConfig!,
      changedBy,
      changedAt: new Date(),
    };

    configEmitter.emit('configChanged', changeEvent);

    logger.info('Platform configuration updated', {
      tenantId,
      platform: currentConfig.platform,
      changedBy,
    });

    return { success: true };

  } catch (error) {
    logger.error('Failed to update platform configuration', 
      error instanceof Error ? error : new Error(String(error)),
      { tenantId }
    );
    return { success: false, error: 'Database error' };
  }
}

/**
 * Validate configuration updates
 */
function validateConfiguration(config: Partial<PlatformConfiguration>): { valid: boolean; error?: string } {
  if (config.apiBaseUrl !== undefined) {
    try {
      new URL(config.apiBaseUrl);
    } catch {
      return { valid: false, error: 'Invalid API base URL' };
    }
  }

  if (config.region !== undefined && typeof config.region !== 'string') {
    return { valid: false, error: 'Region must be a string' };
  }

  if (config.instanceId !== undefined && typeof config.instanceId !== 'string') {
    return { valid: false, error: 'Instance ID must be a string' };
  }

  return { valid: true };
}

/**
 * Watch for configuration changes and auto-reload
 */
export async function startConfigWatcher(
  tenantId: string,
  checkIntervalMs: number = 30000
): Promise<void> {
  const watcherKey = `${tenantId}:watcher`;

  // Stop existing watcher
  stopConfigWatcher(tenantId);

  // Get initial config hash
  const config = await getPlatformConfiguration(tenantId);
  if (config) {
    configHashMap.set(`${tenantId}:${config.platform}`, JSON.stringify(config));
  }

  // Start watching
  const interval = setInterval(async () => {
    await checkForConfigChanges(tenantId);
  }, checkIntervalMs);

  activeWatchers.set(watcherKey, interval);

  logger.info('Started platform config watcher', { tenantId, interval: checkIntervalMs });
}

/**
 * Stop watching for configuration changes
 */
export function stopConfigWatcher(tenantId: string): void {
  const watcherKey = `${tenantId}:watcher`;
  const interval = activeWatchers.get(watcherKey);

  if (interval) {
    clearInterval(interval);
    activeWatchers.delete(watcherKey);
    // Clean up cached hash entries for this tenant to prevent memory leaks
    for (const key of configHashMap.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        configHashMap.delete(key);
      }
    }
    logger.info('Stopped platform config watcher', { tenantId });
  }
}

/**
 * Check if configuration has changed
 */
async function checkForConfigChanges(tenantId: string): Promise<void> {
  try {
    const config = await getPlatformConfiguration(tenantId);
    
    if (!config) {
      return;
    }

    const cacheKey = `${tenantId}:${config.platform}`;
    const currentHash = JSON.stringify(config);
    const previousHash = configHashMap.get(cacheKey);

    if (previousHash && previousHash !== currentHash) {
      // Config has changed
      logger.info('Detected configuration change, reloading provider', {
        tenantId,
        platform: config.platform,
      });

      // Clear cache to force reload
      clearPlatformVoiceProviderCache(tenantId);

      // Emit event
      configEmitter.emit('configReloaded', {
        tenantId,
        platform: config.platform,
        reloadedAt: new Date(),
      });
    }

    // Update hash
    configHashMap.set(cacheKey, currentHash);

  } catch (error) {
    logger.error('Error checking for config changes', 
      error instanceof Error ? error : new Error(String(error)),
      { tenantId }
    );
  }
}

/**
 * Subscribe to configuration changes
 */
export function onConfigChanged(
  callback: (event: ConfigChangeEvent) => void
): () => void {
  configEmitter.on('configChanged', callback);
  return () => configEmitter.off('configChanged', callback);
}

/**
 * Subscribe to configuration reloads
 */
export function onConfigReloaded(
  callback: (event: { tenantId: string; platform: string; reloadedAt: Date }) => void
): () => void {
  configEmitter.on('configReloaded', callback);
  return () => configEmitter.off('configReloaded', callback);
}

/**
 * Get configuration audit trail
 */
export async function getConfigAuditTrail(
  tenantId: string,
  limit: number = 50
): Promise<Array<{
  id: number;
  platform: string;
  changedBy: string;
  changedAt: Date;
  changes: string[];
}>> {
  const result = await query(
    `SELECT 
      id,
      platform,
      previous_config,
      new_config,
      changed_by,
      changed_at
    FROM platform_config_audit
    WHERE tenant_id = $1
    ORDER BY changed_at DESC
    LIMIT $2`,
    [tenantId, limit]
  );

  return result.rows.map(row => {
    const previous = JSON.parse(row.previous_config || '{}');
    const current = JSON.parse(row.new_config || '{}');
    const changes = detectChanges(previous, current);

    return {
      id: row.id,
      platform: row.platform,
      changedBy: row.changed_by,
      changedAt: row.changed_at,
      changes,
    };
  });
}

/**
 * Detect what changed between two configurations
 */
function detectChanges(previous: PlatformConfiguration, current: PlatformConfiguration): string[] {
  const changes: string[] = [];

  const fieldsToCheck: (keyof PlatformConfiguration)[] = [
    'apiBaseUrl',
    'region',
    'instanceId',
    'supportsVoice',
    'supportsChat',
    'supportsEmail',
    'supportsSMS',
    'isActive',
  ];

  for (const field of fieldsToCheck) {
    if (previous[field] !== current[field]) {
      changes.push(`${field}: ${previous[field]} → ${current[field]}`);
    }
  }

  return changes;
}

/**
 * Bulk update configurations
 */
export async function bulkUpdateConfigurations(
  updates: Array<{ tenantId: string; changes: Partial<PlatformConfiguration> }>,
  changedBy: string
): Promise<{ success: number; failed: number; errors: string[] }> {
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const update of updates) {
    const result = await updatePlatformConfiguration(
      update.tenantId,
      update.changes,
      changedBy
    );

    if (result.success) {
      success++;
    } else {
      failed++;
      errors.push(`${update.tenantId}: ${result.error}`);
    }
  }

  return { success, failed, errors };
}

/**
 * Validate platform configurations for a tenant
 * Validate all platform configurations
 */
export async function validateAllConfigurations(tenantId?: string): Promise<Array<{
  tenantId: string;
  platform: string;
  valid: boolean;
  errors: string[];
}>> {
  const result = await query(
    tenantId
      ? `SELECT tenant_id, platform FROM tenant_platform_configs WHERE is_active = true AND tenant_id = $1`
      : `SELECT tenant_id, platform FROM tenant_platform_configs WHERE is_active = true`,
    tenantId ? [tenantId] : []
  );

  const validations = [];

  for (const row of result.rows) {
    // CRITICAL FIX: pass the specific platform to ensure we validate the
    // correct configuration, not a different platform for the same tenant.
    const config = await getPlatformConfiguration(row.tenant_id, row.platform);
    const errors: string[] = [];

    if (!config) {
      errors.push('Configuration not found');
    } else {
      if (!config.apiBaseUrl) {
        errors.push('Missing API base URL');
      }

      if (config.platform === 'amazon_connect' && !config.instanceId) {
        errors.push('Missing instance ID for Amazon Connect');
      }

      if (config.platform === 'genesys_cloud' && !config.region) {
        errors.push('Missing region for Genesys Cloud');
      }
    }

    validations.push({
      tenantId: row.tenant_id,
      platform: row.platform,
      valid: errors.length === 0,
      errors,
    });
  }

  return validations;
}

// Cleanup on process exit — use a stable global reference so HMR reloads
// remove the old handler before adding a new one, preventing listener leaks.
const CONFIG_MANAGER_SIGINT = Symbol.for('cxc:platformConfigManager:sigint');
const configManagerSigintHandler = () => {
  for (const [key, interval] of activeWatchers.entries()) {
    clearInterval(interval);
  }
  activeWatchers.clear();
  configHashMap.clear();
};
// Remove any previously-registered handler (from prior HMR load)
const oldHandler = (globalThis as unknown as Record<symbol, (() => void) | undefined>)[CONFIG_MANAGER_SIGINT];
if (oldHandler) {
  process.removeListener('SIGINT', oldHandler);
}
(globalThis as unknown as Record<symbol, (() => void) | undefined>)[CONFIG_MANAGER_SIGINT] = configManagerSigintHandler;
process.on('SIGINT', configManagerSigintHandler);
