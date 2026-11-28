import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { UserDocument } from '../users/schemas/user.schema';
import { MailService } from '../mail/mail.service';
import { Otp, OtpDocument } from './schemas/otp.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(Otp.name) private readonly otpModel: Model<OtpDocument>,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly mailService: MailService,
  ) {}

  private generateToken(user: UserDocument): string {
    return this.jwtService.sign({
      sub: String(user._id),
      email: user.email,
      role: user.role,
    });
  }

  async register(dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const newUser = await this.usersService.create({
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      password: dto.password,
    });

    const token = this.generateToken(newUser);
    return { token, user: newUser };
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email, true);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.active) {
      throw new UnauthorizedException('Account is inactive');
    }

    const isValid = await bcrypt.compare(dto.password, user.password || '');
    if (!isValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const loginEntry = new Date().toISOString();
    // Record login history in the background so login doesn't wait on extra DB round-trips
    void this.usersService.addLoginHistory(String(user._id), loginEntry).catch((err) => {
      console.warn('Failed to record login history:', err?.message || err);
    });

    const userObj = user.toObject ? user.toObject() : { ...user };
    delete (userObj as any).password;

    const token = this.generateToken(user);
    return { token, user: userObj };
  }

  async sendOtp(dto: SendOtpDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new NotFoundException('No account found with this email');
    }

    const cleanEmail = dto.email.toLowerCase().trim();
    await this.otpModel.deleteMany({ email: cleanEmail });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const rounds = this.config.get<number>('bcryptRounds') ?? 10;
    const hashedOtp = await bcrypt.hash(otp, rounds);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await this.otpModel.create({
      email: cleanEmail,
      hashedOtp,
      expiresAt,
      used: false,
    });

    console.log(`[OTP] Email: ${dto.email} | OTP: ${otp} | Expires: ${expiresAt.toISOString()}`);
    await this.mailService.sendOtpEmail(cleanEmail, otp);

    return { message: 'OTP sent successfully to your email' };
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<boolean> {
    const cleanEmail = dto.email.toLowerCase().trim();
    const record = await this.otpModel
      .findOne({ email: cleanEmail, used: false })
      .sort({ createdAt: -1 });

    if (!record) {
      throw new BadRequestException('OTP not found or already used');
    }

    if (new Date() > new Date(record.expiresAt)) {
      throw new BadRequestException('OTP has expired');
    }

    const isValid = await bcrypt.compare(dto.otp, record.hashedOtp);
    if (!isValid) {
      throw new BadRequestException('Invalid OTP');
    }

    return true;
  }

  async resetPassword(dto: ResetPasswordDto) {
    await this.verifyOtp({ email: dto.email, otp: dto.otp });

    const cleanEmail = dto.email.toLowerCase().trim();
    const user = await this.usersService.findByEmail(cleanEmail, true);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const rounds = this.config.get<number>('bcryptRounds') ?? 10;
    const newHashedPassword = await bcrypt.hash(dto.newPassword, rounds);

    await this.usersService.setPassword(String(user._id), newHashedPassword);
    await this.otpModel.updateMany({ email: cleanEmail }, { used: true });

    return { message: 'Password reset successfully' };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.usersService.update(userId, dto);
    return { user };
  }
}
