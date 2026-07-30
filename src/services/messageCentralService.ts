import { SettingsModel } from '../models/Settings';
import { logger } from '../lib/logger';

interface SendOtpResponse {
  success: boolean;
  verificationId?: string;
  message?: string;
}

interface VerifyOtpResponse {
  success: boolean;
  message?: string;
}

interface MessageCentralConfig {
  enabled: boolean;
  customerId: string;
  email: string;
  password: string;
  baseUrl: string;
  countryCode: string;
  otpLength: number;
  flowType: string;
}

const STATIC_OTP = '1234';
const STATIC_VERIFICATION_ID = 'static-otp-verification';
const DEFAULT_BASE = 'https://cpaas.messagecentral.com';

export class MessageCentralService {
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  private async loadConfig(): Promise<MessageCentralConfig> {
    const s: any = await SettingsModel.findOne().lean();
    const otpLen = Number(s?.messageCentralOtpLength || 4);
    return {
      enabled: !!s?.messageCentralEnabled,
      customerId: String(s?.messageCentralCustomerId || '').trim(),
      email: String(s?.messageCentralEmail || '').trim(),
      password: String(s?.messageCentralPassword || ''),
      baseUrl: String(s?.messageCentralBaseUrl || DEFAULT_BASE).replace(/\/$/, ''),
      countryCode: String(s?.messageCentralCountryCode || '91').replace(/^\+/, ''),
      otpLength: otpLen >= 4 && otpLen <= 8 ? otpLen : 4,
      flowType: String(s?.messageCentralFlowType || 'SMS').toUpperCase(),
    };
  }

  private useLive(cfg: MessageCentralConfig) {
    return cfg.enabled && !!cfg.customerId && !!cfg.password;
  }

  private async getAuthToken(cfg: MessageCentralConfig): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const key = Buffer.from(cfg.password, 'utf8').toString('base64');
    const params = new URLSearchParams({
      customerId: cfg.customerId,
      key,
      scope: 'NEW',
      country: cfg.countryCode,
      ...(cfg.email ? { email: cfg.email } : {}),
    });

    const url = `${cfg.baseUrl}/auth/v1/authentication/token?${params.toString()}`;
    const res = await fetch(url, { method: 'GET' });
    const data: any = await res.json().catch(() => ({}));

    const token =
      data?.token ||
      data?.authToken ||
      data?.data?.token ||
      data?.data?.authToken ||
      '';

    if (!token) {
      logger.error({ data, status: res.status }, 'Message Central token failed');
      throw new Error(data?.message || data?.errorMessage || 'Failed to get Message Central auth token');
    }

    this.cachedToken = String(token);
    // Tokens typically last ~1h — refresh a bit early
    this.tokenExpiresAt = Date.now() + 50 * 60 * 1000;
    return this.cachedToken;
  }

  /** Invalidate cached token (e.g. after 401 from send/validate) */
  private clearToken() {
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
  }

  async sendOtp(mobileNumber: string): Promise<SendOtpResponse> {
    const cfg = await this.loadConfig();
    const phone = String(mobileNumber || '').replace(/\D/g, '').slice(-10);

    if (cfg.enabled && (!cfg.customerId || !cfg.password)) {
      return {
        success: false,
        message:
          'Message Central is enabled but API keys are missing. Add Customer ID and Password in Admin → Settings → Message Central.',
      };
    }

    if (!this.useLive(cfg)) {
      logger.warn('Message Central disabled — using static OTP 1234 (dev only)');
      return {
        success: true,
        verificationId: STATIC_VERIFICATION_ID,
        message: `OTP sent successfully. Use ${STATIC_OTP} as OTP (Message Central disabled)`,
      };
    }

    try {
      let token = await this.getAuthToken(cfg);
      const params = new URLSearchParams({
        countryCode: cfg.countryCode,
        flowType: cfg.flowType || 'SMS',
        mobileNumber: phone,
        otpLength: String(cfg.otpLength),
      });

      const doSend = async (authToken: string) => {
        const res = await fetch(`${cfg.baseUrl}/verification/v3/send?${params.toString()}`, {
          method: 'POST',
          headers: { authToken },
        });
        const data: any = await res.json().catch(() => ({}));
        return { res, data };
      };

      let { res, data } = await doSend(token);
      // Retry once with fresh token on auth failure
      if (res.status === 401 || data?.responseCode === 401 || /token|unauthor/i.test(String(data?.message || ''))) {
        this.clearToken();
        token = await this.getAuthToken(cfg);
        ({ res, data } = await doSend(token));
      }

      const verificationId =
        data?.data?.verificationId ||
        data?.verificationId ||
        data?.data?.verification_id ||
        '';

      const ok =
        !!verificationId ||
        res.ok ||
        data?.responseCode === 200 ||
        data?.status === 200 ||
        String(data?.message || '').toLowerCase().includes('success');

      if (!ok || !verificationId) {
        logger.error({ data, status: res.status }, 'Message Central send OTP failed');
        return {
          success: false,
          message: data?.message || data?.errorMessage || 'Failed to send OTP via Message Central',
        };
      }

      return {
        success: true,
        verificationId: String(verificationId),
        message: 'OTP sent successfully',
      };
    } catch (err: any) {
      logger.error({ err }, 'Message Central send OTP error');
      return {
        success: false,
        message: err?.message || 'Failed to send OTP',
      };
    }
  }

  async verifyOtp(verificationId: string | undefined, code: string): Promise<VerifyOtpResponse> {
    const cfg = await this.loadConfig();
    const otp = String(code || '').trim();

    if (cfg.enabled && (!cfg.customerId || !cfg.password)) {
      return {
        success: false,
        message:
          'Message Central is enabled but API keys are missing. Configure them in Admin → Settings → Message Central.',
      };
    }

    // Static / test path only when Message Central is disabled
    if (!this.useLive(cfg) || verificationId === STATIC_VERIFICATION_ID) {
      if (this.useLive(cfg) && verificationId === STATIC_VERIFICATION_ID) {
        return { success: false, message: 'Invalid verification session. Request a new OTP.' };
      }
      if (otp === STATIC_OTP) {
        return { success: true, message: 'OTP verified successfully' };
      }
      return {
        success: false,
        message: `Invalid OTP. Use ${STATIC_OTP}`,
      };
    }

    if (!verificationId) {
      return { success: false, message: 'Missing verificationId — request a new OTP' };
    }

    try {
      let token = await this.getAuthToken(cfg);
      const params = new URLSearchParams({
        verificationId: String(verificationId),
        code: otp,
      });

      const doValidate = async (authToken: string) => {
        const res = await fetch(`${cfg.baseUrl}/verification/v3/validateOtp?${params.toString()}`, {
          method: 'GET',
          headers: { authToken },
        });
        const data: any = await res.json().catch(() => ({}));
        return { res, data };
      };

      let { res, data } = await doValidate(token);
      if (res.status === 401 || data?.responseCode === 401) {
        this.clearToken();
        token = await this.getAuthToken(cfg);
        ({ res, data } = await doValidate(token));
      }

      const verificationStatus = String(
        data?.data?.verificationStatus ||
        data?.verificationStatus ||
        data?.data?.status ||
        ''
      ).toUpperCase();

      const responseCode = Number(data?.responseCode ?? data?.status ?? res.status);

      if (/FAIL|INVALID|EXPIRED|REJECT/i.test(verificationStatus)) {
        return { success: false, message: data?.message || 'Invalid or expired OTP' };
      }

      const ok =
        verificationStatus === 'VERIFICATION_COMPLETED' ||
        verificationStatus === 'SUCCESS' ||
        verificationStatus === 'VERIFIED' ||
        (responseCode === 200 && !verificationStatus);

      if (!ok) {
        return {
          success: false,
          message: data?.message || data?.errorMessage || 'Invalid or expired OTP',
        };
      }

      return { success: true, message: 'OTP verified successfully' };
    } catch (err: any) {
      logger.error({ err }, 'Message Central verify OTP error');
      return { success: false, message: err?.message || 'OTP verification failed' };
    }
  }
}
