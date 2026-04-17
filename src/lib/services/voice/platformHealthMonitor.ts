     1|/**
     2| * Platform Health Monitor
     3| * 
     4| * Enterprise-grade health monitoring for all voice platforms:
     5| * - Real-time health checks
     6| * - Metrics aggregation
     7| * - Alerting on platform degradation
     8| * - Historical health data
     9| * - Dashboard API for visualization
    10| * 
    11| * @module services/voice/platformHealthMonitor
    12| */
    13|
    14|import { query } from '$lib/server/db.js';
    15|import { logger } from '$lib/utils/logger.js';
    16|import { getPlatformVoiceProvider, clearPlatformVoiceProviderCache } from './platformVoiceAdapter.js';
    17|import type { PlatformMetrics } from './resilientPlatformProvider.js';
    18|import { ResilientPlatformProvider } from './resilientPlatformProvider.js';
    19|
    20|export interface PlatformHealthStatus {
    21|  tenantId: string;
    22|  platform: string;
    23|  isHealthy: boolean;
    24|  lastCheck: Date;
    25|  latencyMs: number;
    26|  uptime: number;
    27|  errorRate: number;
    28|  circuitBreakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    29|  details?: Record<string, unknown>;
    30|}
    31|
    32|export interface PlatformHealthHistory {
    33|  timestamp: Date;
    34|  isHealthy: boolean;
    35|  latencyMs: number;
    36|  errorMessage?: string;
    37|}
    38|
    39|interface HealthCheckConfig {
    40|  checkIntervalMs: number;
    41|  historyRetentionHours: number;
    42|  alertThresholdLatency: number;
    43|  alertThresholdErrorRate: number;
    44|}
    45|
    46|const DEFAULT_CONFIG: HealthCheckConfig = {
    47|  checkIntervalMs: 30000,        // Check every 30 seconds
    48|  historyRetentionHours: 24,     // Keep 24 hours of history
    49|  alertThresholdLatency: 5000,   // Alert if latency > 5 seconds
    50|  alertThresholdErrorRate: 0.1,  // Alert if error rate > 10%
    51|};
    52|
    53|// In-memory storage for health status
    54|const healthStatusMap = new Map<string, PlatformHealthStatus>();
    55|const healthHistoryMap = new Map<string, PlatformHealthHistory[]>();
    56|const activeMonitors = new Map<string, NodeJS.Timeout>();
    57|
    58|/**
    59| * Get current health status for a tenant's platforms
    60| * SECURITY FIX: Now requires tenantId parameter to prevent cross-tenant data leakage
    61| */
/**
 * Get current health status for all platforms
 */
export async function getAllPlatformHealth(tenantId?: string): Promise<PlatformHealthStatus[]> {
  // SECURITY: If no tenantId provided, return empty array to prevent data leak
  if (!tenantId) {
    return [];
  }

  const result = await query(
    `SELECT 
      t.id as tenant_id,
      t.name as tenant_name,
      tpc.platform,
      tpc.is_active,
      tpc.is_connected
    FROM tenant_platform_configs tpc
    JOIN tenants t ON tpc.tenant_id = t.id
    WHERE tpc.is_active = true AND tpc.tenant_id = $1`,
    [tenantId]
  );
    81|
    82|  const healthStatuses: PlatformHealthStatus[] = [];
    83|
    84|  for (const row of result.rows) {
    85|    const cacheKey = `${row.tenant_id}:${row.platform}`;
    86|    const cached = healthStatusMap.get(cacheKey);
    87|    
    88|    if (cached) {
    89|      healthStatuses.push(cached);
    90|    } else {
    91|      // Return basic status if not yet monitored
    92|      healthStatuses.push({
    93|        tenantId: row.tenant_id,
    94|        platform: row.platform,
    95|        isHealthy: row.is_connected,
    96|        lastCheck: new Date(),
    97|        latencyMs: 0,
    98|        uptime: 0,
    99|        errorRate: 0,
   100|        circuitBreakerState: 'CLOSED',
   101|      });
   102|    }
   103|  }
   104|
   105|  return healthStatuses;
   106|}
   107|
   108|/**
   109| * Get health status for a specific tenant's platform
   110| */
   111|export async function getPlatformHealth(tenantId: string): Promise<PlatformHealthStatus | null> {
   112|  const result = await query(
   113|    `SELECT platform FROM tenant_platform_configs 
   114|     WHERE tenant_id = $1 AND is_active = true`,
   115|    [tenantId]
   116|  );
   117|
   118|  if (result.rows.length === 0) {
   119|    return null;
   120|  }
   121|
   122|  const platform = result.rows[0].platform;
   123|  const cacheKey = `${tenantId}:${platform}`;
   124|  
   125|  return healthStatusMap.get(cacheKey) || null;
   126|}
   127|
   128|/**
   129| * Get health history for a tenant's platform
   130| */
   131|export async function getPlatformHealthHistory(
   132|  tenantId: string, 
   133|  hours: number = 24
   134|): Promise<PlatformHealthHistory[]> {
   135|  const result = await query(
   136|    `SELECT platform FROM tenant_platform_configs 
   137|     WHERE tenant_id = $1 AND is_active = true`,
   138|    [tenantId]
   139|  );
   140|
   141|  if (result.rows.length === 0) {
   142|    return [];
   143|  }
   144|
   145|  const platform = result.rows[0].platform;
   146|  const cacheKey = `${tenantId}:${platform}`;
   147|  const history = healthHistoryMap.get(cacheKey) || [];
   148|  
   149|  // Filter to requested time range
   150|  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
   151|  return history.filter(h => h.timestamp >= cutoff);
   152|}
   153|
   154|/**
   155| * Start health monitoring for a tenant's platform
   156| */
   157|export async function startHealthMonitoring(
   158|  tenantId: string, 
   159|  config: Partial<HealthCheckConfig> = {}
   160|): Promise<void> {
   161|  const fullConfig = { ...DEFAULT_CONFIG, ...config };
   162|  const cacheKey = `${tenantId}:monitor`;
   163|
   164|  // Stop existing monitor if any
   165|  stopHealthMonitoring(tenantId);
   166|
   167|  // Start new monitor
   168|  const interval = setInterval(async () => {
   169|    await performHealthCheck(tenantId, fullConfig);
   170|  }, fullConfig.checkIntervalMs);
   171|
   172|  activeMonitors.set(cacheKey, interval);
   173|
   174|  // Perform initial check
   175|  await performHealthCheck(tenantId, fullConfig);
   176|
   177|  logger.info('Started platform health monitoring', { tenantId, interval: fullConfig.checkIntervalMs });
   178|}
   179|
   180|/**
   181| * Stop health monitoring for a tenant's platform
   182| */
   183|export function stopHealthMonitoring(tenantId: string): void {
   184|  const cacheKey = `${tenantId}:monitor`;
   185|  const interval = activeMonitors.get(cacheKey);
   186|  
   187|  if (interval) {
   188|    clearInterval(interval);
   189|    activeMonitors.delete(cacheKey);
   190|    logger.info('Stopped platform health monitoring', { tenantId });
   191|  }
   192|}
   193|
   194|/**
   195| * Perform a health check for a tenant's platform
   196| */
   197|async function performHealthCheck(
   198|  tenantId: string, 
   199|  config: HealthCheckConfig
   200|): Promise<void> {
   201|  try {
   202|    const provider = await getPlatformVoiceProvider(tenantId);
   203|    const startTime = Date.now();
   204|
   205|    // Wrap with resilient provider if not already
   206|    const resilientProvider = provider instanceof ResilientPlatformProvider 
   207|      ? provider 
   208|      : new ResilientPlatformProvider(provider);
   209|
   210|    // Perform health check
   211|    const healthResult = await resilientProvider.isHealthy();
   212|    const latencyMs = Date.now() - startTime;
   213|
   214|    // Get metrics
   215|    const metrics = resilientProvider.getMetrics();
   216|    const errorRate = metrics.totalCalls > 0 
   217|      ? metrics.failedCalls / metrics.totalCalls 
   218|      : 0;
   219|
   220|    // Calculate uptime (simplified - would track actual uptime)
   221|    const uptime = healthResult.ok ? 1 : 0;
   222|
   223|    // Get platform info
   224|    const platformResult = await query(
   225|      `SELECT platform FROM tenant_platform_configs WHERE tenant_id = $1 AND is_active = true`,
   226|      [tenantId]
   227|    );
   228|    const platform = platformResult.rows[0]?.platform || 'unknown';
   229|
   230|    // Update health status
   231|    const cacheKey = `${tenantId}:${platform}`;
   232|    const status: PlatformHealthStatus = {
   233|      tenantId,
   234|      platform,
   235|      isHealthy: healthResult.ok,
   236|      lastCheck: new Date(),
   237|      latencyMs,
   238|      uptime,
   239|      errorRate,
   240|      circuitBreakerState: resilientProvider.getCircuitBreakerState(),
   241|      details: healthResult.details,
   242|    };
   243|
   244|    healthStatusMap.set(cacheKey, status);
   245|
   246|    // Update history
   247|    const history = healthHistoryMap.get(cacheKey) || [];
   248|    history.push({
   249|      timestamp: new Date(),
   250|      isHealthy: healthResult.ok,
   251|      latencyMs,
   252|      errorMessage: healthResult.details?.error as string,
   253|    });
   254|
   255|    // Trim old history
   256|    const cutoff = new Date(Date.now() - config.historyRetentionHours * 60 * 60 * 1000);
   257|    while (history.length > 0 && history[0].timestamp < cutoff) {
   258|      history.shift();
   259|    }
   260|
   261|    healthHistoryMap.set(cacheKey, history);
   262|
   263|    // Check alert thresholds
   264|    checkAlertThresholds(tenantId, platform, status, config);
   265|
   266|  } catch (error) {
   267|    logger.error('Health check failed', error instanceof Error ? error : new Error(String(error)), { tenantId });
   268|  }
   269|}
   270|
   271|/**
   272| * Check if health status triggers alerts
   273| */
   274|function checkAlertThresholds(
   275|  tenantId: string,
   276|  platform: string,
   277|  status: PlatformHealthStatus,
   278|  config: HealthCheckConfig
   279|): void {
   280|  const alerts: string[] = [];
   281|
   282|  if (status.latencyMs > config.alertThresholdLatency) {
   283|    alerts.push(`High latency: ${status.latencyMs}ms (threshold: ${config.alertThresholdLatency}ms)`);
   284|  }
   285|
   286|  if (status.errorRate > config.alertThresholdErrorRate) {
   287|    alerts.push(`High error rate: ${(status.errorRate * 100).toFixed(1)}% (threshold: ${(config.alertThresholdErrorRate * 100).toFixed(1)}%)`);
   288|  }
   289|
   290|  if (status.circuitBreakerState === 'OPEN') {
   291|    alerts.push('Circuit breaker is OPEN');
   292|  }
   293|
   294|  if (!status.isHealthy) {
   295|    alerts.push('Platform health check failed');
   296|  }
   297|
   298|  if (alerts.length > 0) {
   299|    logger.warning(`Platform health alerts for ${tenantId}/${platform}`, {
   300|      tenantId,
   301|      platform,
   302|      alerts,
   303|      status,
   304|    });
   305|
   306|    // Store alert in database
   307|    query(
   308|      `INSERT INTO platform_health_alerts (tenant_id, platform, alerts, status, created_at)
   309|       VALUES ($1, $2, $3, $4, NOW())`,
   310|      [tenantId, platform, JSON.stringify(alerts), JSON.stringify(status)]
   311|    ).catch(err => {
   312|      logger.error('Failed to store health alert', err instanceof Error ? err : new Error(String(err)));
   313|    });
   314|  }
   315|}
   316|
   317|/**
   318| * Get aggregated metrics for a tenant's platforms
   319| * SECURITY FIX: Now requires tenantId parameter to prevent cross-tenant data leakage
   320| */
   321|export async function getAggregatedMetrics(tenantId?: string): Promise<{
   322|  totalPlatforms: number;
   323|  healthyPlatforms: number;
   324|  unhealthyPlatforms: number;
   325|  averageLatency: number;
   326|  totalCalls: number;
   327|  successRate: number;
   328|}> {
   329|  const healthStatuses = await getAllPlatformHealth(tenantId);
   330|  
   331|  if (healthStatuses.length === 0) {
   332|    return {
   333|      totalPlatforms: 0,
   334|      healthyPlatforms: 0,
   335|      unhealthyPlatforms: 0,
   336|      averageLatency: 0,
   337|      totalCalls: 0,
   338|      successRate: 0,
   339|    };
   340|  }
   341|
   342|  const healthyPlatforms = healthStatuses.filter(h => h.isHealthy).length;
   343|  const totalLatency = healthStatuses.reduce((sum, h) => sum + h.latencyMs, 0);
   344|  const totalErrorRate = healthStatuses.reduce((sum, h) => sum + h.errorRate, 0);
   345|
   346|  return {
   347|    totalPlatforms: healthStatuses.length,
   348|    healthyPlatforms,
   349|    unhealthyPlatforms: healthStatuses.length - healthyPlatforms,
   350|    averageLatency: totalLatency / healthStatuses.length,
   351|    totalCalls: 0, // Would need to aggregate from metrics
   352|    successRate: 1 - (totalErrorRate / healthStatuses.length),
   353|  };
   354|}
   355|
   356|/**
   357| * Start monitoring for all active platforms
   358| */
   359|export async function startAllHealthMonitoring(): Promise<void> {
   360|  const result = await query(
   361|    `SELECT DISTINCT tenant_id 
   362|     FROM tenant_platform_configs 
   363|     WHERE is_active = true`
   364|  );
   365|
   366|  for (const row of result.rows) {
   367|    await startHealthMonitoring(row.tenant_id);
   368|  }
   369|
   370|  logger.info('Started health monitoring for all platforms', { count: result.rows.length });
   371|}
   372|
   373|/**
   374| * Stop all health monitoring
   375| */
   376|export function stopAllHealthMonitoring(): void {
   377|  for (const [key, interval] of activeMonitors.entries()) {
   378|    clearInterval(interval);
   379|    activeMonitors.delete(key);
   380|  }
   381|
   382|  logger.info('Stopped all platform health monitoring');
   383|}
   384|
   385|/**
   386| * Get platform comparison data for a tenant
   387| * SECURITY FIX: Now requires tenantId parameter to prevent cross-tenant data leakage
   388| */
   389|export async function getPlatformComparison(tenantId?: string): Promise<Array<{
   390|  platform: string;
   391|  tenantCount: number;
   392|  averageLatency: number;
   393|  healthPercentage: number;
   394|}>> {
   395|  // SECURITY: If no tenantId provided, return empty array to prevent data leak
   396|  if (!tenantId) {
   397|    return [];
   398|  }
   399|
   400|  const result = await query(
   401|    `SELECT 
   402|      platform,
   403|      COUNT(*) as tenant_count
   404|    FROM tenant_platform_configs
   405|    WHERE is_active = true AND tenant_id = $1
   406|    GROUP BY platform`,
   407|    [tenantId]
   408|  );
   409|
   410|  const comparisons = [];
   411|
   412|  for (const row of result.rows) {
   413|    // Get health statuses for this platform and tenant
   414|    const platformHealthStatuses: PlatformHealthStatus[] = [];
   415|    for (const [key, status] of healthStatusMap.entries()) {
   416|      if (status.platform === row.platform && status.tenantId === tenantId) {
   417|        platformHealthStatuses.push(status);
   418|      }
   419|    }
   420|
   421|    if (platformHealthStatuses.length > 0) {
   422|      const avgLatency = platformHealthStatuses.reduce((sum, h) => sum + h.latencyMs, 0) / platformHealthStatuses.length;
   423|      const healthCount = platformHealthStatuses.filter(h => h.isHealthy).length;
   424|      const healthPercentage = (healthCount / platformHealthStatuses.length) * 100;
   425|
   426|      comparisons.push({
   427|        platform: row.platform,
   428|        tenantCount: parseInt(row.tenant_count),
   429|        averageLatency: avgLatency,
   430|        healthPercentage,
   431|      });
   432|    } else {
   433|      comparisons.push({
   434|        platform: row.platform,
   435|        tenantCount: parseInt(row.tenant_count),
   436|        averageLatency: 0,
   437|        healthPercentage: 0,
   438|      });
   439|    }
   440|  }
   441|
   442|  return comparisons;
   443|}
   444|
   445|// Cleanup on process exit
   446|process.on('SIGINT', () => {
   447|  stopAllHealthMonitoring();
   448|});
   449|
   450|process.on('SIGTERM', () => {
   451|  stopAllHealthMonitoring();
   452|});
   453|