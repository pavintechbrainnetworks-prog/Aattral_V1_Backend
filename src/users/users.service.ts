import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { User, UserDocument, UserRole } from './schemas/user.schema';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

export { UserRole, UserDocument, User };
export type UserEntity = UserDocument;

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly config: ConfigService,
  ) {}

  async findAll(): Promise<UserDocument[]> {
    return this.userModel.find().sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<UserDocument | null> {
    if (!id || !Types.ObjectId.isValid(id)) {
      return null;
    }
    return this.userModel.findById(id).exec();
  }

  async findByEmail(
    email: string,
    withPassword = false,
  ): Promise<UserDocument | null> {
    if (!email) return null;
    const query = this.userModel.findOne({ email: email.toLowerCase().trim() });
    if (withPassword) {
      query.select('+password');
    }
    return query.exec();
  }

  async create(dto: CreateUserDto): Promise<UserDocument> {
    const existing = await this.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already in use');
    }

    const rounds = this.config.get<number>('bcryptRounds') ?? 10;
    const hashedPassword = await bcrypt.hash(dto.password, rounds);

    const user = new this.userModel({
      name: dto.name.trim(),
      email: dto.email.toLowerCase().trim(),
      phone: dto.phone?.trim(),
      password: hashedPassword,
      role: dto.role ?? UserRole.USER,
      active: true,
      loginHistory: [],
    });

    return user.save();
  }

  async update(id: string, dto: UpdateUserDto): Promise<UserDocument> {
    if (!id || !Types.ObjectId.isValid(id)) {
      throw new NotFoundException('User not found');
    }

    const updatePayload: Record<string, any> = {};
    if (dto.name !== undefined) updatePayload.name = dto.name.trim();
    if (dto.phone !== undefined) updatePayload.phone = dto.phone.trim();
    if (dto.role !== undefined) updatePayload.role = dto.role;
    if (dto.active !== undefined) updatePayload.active = dto.active;

    const user = await this.userModel
      .findByIdAndUpdate(id, { $set: updatePayload }, { new: true })
      .exec();

    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async remove(id: string): Promise<void> {
    if (!id || !Types.ObjectId.isValid(id)) {
      throw new NotFoundException('User not found');
    }
    const user = await this.userModel.findByIdAndDelete(id).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
  }

  async toggleActive(id: string): Promise<UserDocument> {
    if (!id || !Types.ObjectId.isValid(id)) {
      throw new NotFoundException('User not found');
    }
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    user.active = !user.active;
    return user.save();
  }

  async addLoginHistory(id: string, entry: string): Promise<UserDocument> {
    if (!id || !Types.ObjectId.isValid(id)) {
      throw new NotFoundException('User not found');
    }
    const user = await this.userModel
      .findByIdAndUpdate(
        id,
        {
          $push: {
            loginHistory: {
              $each: [entry],
              $slice: -50,
            },
          },
        },
        { new: true },
      )
      .exec();

    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async setPassword(id: string, newHashedPassword: string): Promise<void> {
    if (!id || !Types.ObjectId.isValid(id)) {
      throw new NotFoundException('User not found');
    }
    const result = await this.userModel
      .findByIdAndUpdate(id, { password: newHashedPassword })
      .exec();
    if (!result) {
      throw new NotFoundException('User not found');
    }
  }
}
