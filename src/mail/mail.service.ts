import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private readonly config: ConfigService) {
    this.initTransporter();
  }

  private getCleanPass(): string | undefined {
    const raw = this.config.get<string>('mail.pass');
    if (!raw) return undefined;
    // Strip surrounding quotes and any whitespace
    return raw.replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  }

  private initTransporter() {
    const host = this.config.get<string>('mail.host') || 'smtp.gmail.com';
    const port = this.config.get<number>('mail.port') || 465;
    const secure = this.config.get<boolean>('mail.secure') ?? (port === 465);
    const user = this.config.get<string>('mail.user') || 'techbrainnetworks@gmail.com';
    const pass = this.getCleanPass();

    if (!pass) {
      this.logger.warn(
        `SMTP_PASS is not set in backend/.env. Outgoing emails from ${user} will fail until an App Password is provided.`,
      );
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
    });
  }

  async sendOtpEmail(to: string, otp: string): Promise<void> {
    const from =
      this.config.get<string>('mail.from') ||
      '"Techbrain Networks" <techbrainnetworks@gmail.com>';
    const user = this.config.get<string>('mail.user') || 'techbrainnetworks@gmail.com';
    const pass = this.getCleanPass();

    if (!pass) {
      this.logger.error(
        `Cannot send OTP email to ${to}: SMTP_PASS is missing in backend/.env for ${user}.`,
      );
      throw new InternalServerErrorException(
        'Email delivery is not configured on the server. Please set SMTP_PASS (Gmail App Password) for techbrainnetworks@gmail.com in backend/.env',
      );
    }

    const htmlContent = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08); border: 1px solid #e2e8f0;">
        <div style="background-color: #192a56; padding: 28px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 26px; letter-spacing: 1px;">Aattral</h1>
          <p style="color: #a4b0be; margin: 6px 0 0; font-size: 13px;">Powered by Techbrain Networks</p>
        </div>
        <div style="padding: 32px 28px;">
          <h2 style="color: #192a56; font-size: 20px; margin-top: 0;">Password Assistance</h2>
          <p style="color: #4b6584; font-size: 15px; line-height: 1.6;">
            We received a request to reset your password. Use the verification code below to complete the password reset process:
          </p>
          <div style="background-color: #f1f2f6; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
            <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #192a56; font-family: monospace;">${otp}</span>
          </div>
          <p style="color: #747d8c; font-size: 14px; line-height: 1.5;">
            This OTP is valid for <strong>10 minutes</strong>. Do not share this code with anyone.
          </p>
          <p style="color: #747d8c; font-size: 13px; line-height: 1.5; margin-top: 24px;">
            If you did not request this password reset, please disregard this email or contact support if you suspect unauthorized access.
          </p>
        </div>
        <div style="background-color: #f8f9fa; padding: 18px 28px; text-align: center; border-top: 1px solid #e2e8f0;">
          <p style="color: #a4b0be; font-size: 12px; margin: 0;">
            &copy; ${new Date().getFullYear()} Techbrain Networks. All rights reserved.
          </p>
        </div>
      </div>
    `;

    try {
      if (!this.transporter) {
        this.initTransporter();
      }
      await this.transporter!.sendMail({
        from,
        to,
        subject: `Your Aattral Password Reset OTP: ${otp}`,
        text: `Your OTP for password reset is: ${otp}. It expires in 10 minutes. Sent from Techbrain Networks.`,
        html: htmlContent,
      });

      this.logger.log(`[MailService] Successfully sent OTP email to ${to} from ${from}`);
    } catch (err: any) {
      this.logger.error(`[MailService] Failed to send OTP email to ${to}: ${err.message}`, err.stack);
      throw new InternalServerErrorException(
        `Failed to send OTP email: ${err.message || 'SMTP delivery failed'}`,
      );
    }
  }
}
