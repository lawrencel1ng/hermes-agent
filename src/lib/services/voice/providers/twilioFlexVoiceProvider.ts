/**
 * Twilio Flex Voice Provider
 *
 * Wraps the existing TwilioProvider to provide PlatformVoiceProvider
 * semantics for Twilio Flex tenants. This enables incoming/outgoing
 * call control, accept/reject, and conference bridging for agents
 * on the Twilio Flex platform without falling back to FreeSWITCH.
 *
 * Architecture:
 * - Extends PlatformVoiceProvider (same interface as Genesys/Cisco/Amazon)
 * - Delegates call control to TwilioProvider (reads voice_provider_configs)
 * - Maps TaskRouter agent statuses to standard AgentStatusValue
 *
 * @module services/voice/providers/twilioFlexVoiceProvider
 */

import { PlatformVoiceProvider } from '../platformVoiceAdapter.js';
import type {
  ProviderConfig,
  ProviderCall,
  ProviderAgentStatus,
  AgentStatusValue,
  OriginateParams,
  ActiveCallFilters,
  HealthCheckResult,
  SystemStatus
} from '../voiceProvider.js';
import type { PlatformConfig } from '../../platform/PlatformFactory.js';
import { TwilioProvider } from './twilioProvider.js';
import { getVoiceProvider } from '../providerFactory.js';
import { logger } from '$lib/utils/logger.js';

export class TwilioFlexVoiceProvider extends PlatformVoiceProvider {
  readonly name = 'twilio-flex';
  readonly version = '1.0.0';

  private twilioProvider: TwilioProvider | null = null;

  constructor(config: PlatformConfig) {
    super(config);
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  protected async doInitialize(_config: ProviderConfig): Promise<void> {
    // Resolve the tenant's Twilio voice provider from voice_provider_configs.
    // providerFactory maps 'twilio' voice provider ↔ 'twilio_flex' platform.
    const voiceProvider = await getVoiceProvider(this.config.tenantId);

    if (voiceProvider instanceof TwilioProvider) {
      this.twilioProvider = voiceProvider;
    } else if (voiceProvider.name === 'twilio') {
      // If factory returned a Twilio-compatible provider that isn't the exact class
      this.twilioProvider = voiceProvider as unknown as TwilioProvider;
    } else {
      logger.warning(
        'Expected TwilioProvider for Twilio Flex tenant, got different provider. Using as-is.',
        {
          tenantId: this.config.tenantId,
          actualProvider: voiceProvider.name
        },
        { source: 'TwilioFlexVoiceProvider' }
      );
      this.twilioProvider = voiceProvider as unknown as TwilioProvider;
    }
  }

  protected async doShutdown(): Promise<void> {
    // Do NOT shut down the underlying TwilioProvider here — it is cached
    // and shared via providerFactory. Just drop our reference.
    this.twilioProvider = null;
  }

  // ============================================================
  // Health & System
  // ============================================================

  async isHealthy(): Promise<HealthCheckResult> {
    if (!this.twilioProvider) {
      return {
        ok: false,
        provider: this.name,
        latencyMs: 0,
        details: { error: 'Twilio Flex provider not initialized' }
      };
    }
    return this.twilioProvider.isHealthy();
  }

  async getSystemStatus(): Promise<SystemStatus> {
    if (!this.twilioProvider) {
      return {
        running: false,
        provider: this.name,
        uptime: 'unknown',
        version: this.version,
        sessionsActive: 0,
        sessionsTotal: 0,
        registrations: 0,
        details: { error: 'Not initialized' }
      };
    }
    return this.twilioProvider.getSystemStatus();
  }

  // ============================================================
  // Call Control — delegate to TwilioProvider
  // ============================================================

  async originateCall(params: OriginateParams): Promise<ProviderCall> {
    if (!this.twilioProvider) throw new Error('Twilio Flex provider not initialized');
    return this.twilioProvider.originateCall(params);
  }

  async getCall(callId: string): Promise<ProviderCall | null> {
    if (!this.twilioProvider) return null;
    return this.twilioProvider.getCall(callId);
  }

  async getActiveCalls(tenantId: string, filters?: ActiveCallFilters): Promise<ProviderCall[]> {
    if (!this.twilioProvider) return [];
    const calls = await this.twilioProvider.getActiveCalls(tenantId, filters);
    return this.applyActiveCallsFilters(calls, filters);
  }

  async acceptCall(callId: string): Promise<boolean> {
    if (!this.twilioProvider) {
      logger.error('acceptCall called but Twilio Flex provider not initialized', {}, { source: 'TwilioFlexVoiceProvider' });
      return false;
    }
    return this.twilioProvider.acceptCall(callId);
  }

  async rejectCall(callId: string): Promise<boolean> {
    if (!this.twilioProvider) {
      logger.error('rejectCall called but Twilio Flex provider not initialized', {}, { source: 'TwilioFlexVoiceProvider' });
      return false;
    }
    return this.twilioProvider.rejectCall(callId);
  }

  async hangupCall(callId: string, _cause?: string): Promise<boolean> {
    if (!this.twilioProvider) return false;
    return this.twilioProvider.hangupCall(callId);
  }

  async transferCall(callId: string, destination: string, type?: 'blind' | 'attended'): Promise<boolean> {
    if (!this.twilioProvider) return false;
    return this.twilioProvider.transferCall(callId, destination, type);
  }

  async holdCall(callId: string): Promise<boolean> {
    if (!this.twilioProvider) return false;
    return this.twilioProvider.holdCall(callId);
  }

  async resumeCall(callId: string): Promise<boolean> {
    if (!this.twilioProvider) return false;
    return this.twilioProvider.resumeCall(callId);
  }

  async bridgeCall(callId: string, targetCallId: string): Promise<boolean> {
    if (!this.twilioProvider) return false;
    return this.twilioProvider.bridgeCall(callId, targetCallId);
  }

  async sendDtmf(callId: string, digits: string): Promise<boolean> {
    if (!this.twilioProvider) return false;
    return this.twilioProvider.sendDtmf(callId, digits);
  }

  // ============================================================
  // Agent Status — delegate to TwilioProvider (TaskRouter)
  // ============================================================

  async getAgentStatus(agentId: string | number, tenantId: string): Promise<ProviderAgentStatus | null> {
    if (!this.twilioProvider) return null;
    return this.twilioProvider.getAgentStatus(agentId, tenantId);
  }

  async getAllAgentStatuses(tenantId: string): Promise<ProviderAgentStatus[]> {
    if (!this.twilioProvider) return [];
    return this.twilioProvider.getAllAgentStatuses(tenantId);
  }

  async setAgentStatus(agentId: string | number, status: AgentStatusValue, tenantId: string): Promise<boolean> {
    if (!this.twilioProvider) return false;
    return this.twilioProvider.setAgentStatus(agentId, status, tenantId);
  }

  // ============================================================
  // Status Mapping — Twilio Flex / TaskRouter ↔ Standard
  // ============================================================

  protected mapPlatformStatus(platformStatus: string): AgentStatusValue {
    const map: Record<string, AgentStatusValue> = {
      offline: 'offline',
      available: 'available',
      busy: 'busy',
      on_call: 'on_call',
      wrap_up: 'after_call_work',
      break: 'break',
      training: 'training',
      Pending: 'available',
      Reserved: 'busy',
      Assigned: 'on_call',
      Wrapping: 'after_call_work',
      // Twilio Flex worker activity names (common defaults)
      Available: 'available',
      Offline: 'offline',
      Break: 'break',
      'On a Task': 'on_call',
      'Wrap Up': 'after_call_work',
      Unavailable: 'busy'
    };
    return map[platformStatus] || 'offline';
  }

  protected mapToPlatformStatus(status: AgentStatusValue): string {
    const map: Record<AgentStatusValue, string> = {
      offline: 'Offline',
      available: 'Available',
      busy: 'Unavailable',
      on_call: 'On a Task',
      after_call_work: 'Wrap Up',
      break: 'Break',
      training: 'Training'
    };
    return map[status] || 'Offline';
  }
}
