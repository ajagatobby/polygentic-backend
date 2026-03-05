import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Public } from './public.decorator';
import { Roles } from './roles.decorator';
import { UsersService } from './users.service';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { DisableUserDto } from './dto/disable-user.dto';

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  // ─── Public endpoints ────────────────────────────────────────────────

  /**
   * Register a new user account.
   * Creates the user in Firebase Auth and inserts a row in the DB with role=user.
   *
   * Strict rate limit: 5 registrations per IP per hour.
   */
  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({
    short: { limit: 2, ttl: 1000 },
    medium: { limit: 5, ttl: 3600000 },
    long: { limit: 10, ttl: 86400000 },
  })
  @ApiOperation({
    summary: 'Register a new user',
    description:
      'Creates a Firebase Auth account and a DB row with role "user". Rate limited to 5 per hour per IP.',
  })
  async register(@Body() body: RegisterDto) {
    try {
      const dbUser = await this.usersService.createUser({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
      });

      this.logger.log(`New user registered: ${dbUser.uid}`);

      return {
        uid: dbUser.uid,
        email: dbUser.email,
        displayName: dbUser.displayName,
        role: dbUser.role,
        createdAt: dbUser.createdAt,
        message:
          'Account created. Sign in with your email and password to get an ID token.',
      };
    } catch (error: any) {
      // Generic error for all registration failures — prevents account enumeration
      this.logger.warn(
        `Registration failed for ${body.email}: ${error.code || error.message}`,
      );
      throw new BadRequestException(
        'Registration failed. Please check your input and try again.',
      );
    }
  }

  /**
   * Exchange a Firebase refresh token for a new ID token.
   *
   * Rate limited: 10 per minute per IP.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    short: { limit: 3, ttl: 1000 },
    medium: { limit: 10, ttl: 60000 },
    long: { limit: 100, ttl: 3600000 },
  })
  @ApiOperation({
    summary: 'Refresh Firebase ID token',
    description:
      'Exchange a Firebase refresh token for a new ID token. Rate limited to 10 per minute.',
  })
  async refreshToken(@Body() body: RefreshTokenDto) {
    const apiKey = this.configService.get<string>('FIREBASE_WEB_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'FIREBASE_WEB_API_KEY not set — refresh endpoint unavailable',
      );
      throw new BadRequestException('Token refresh is not available');
    }

    try {
      const response = await axios.post(
        `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
        {
          grant_type: 'refresh_token',
          refresh_token: body.refreshToken,
        },
        { timeout: 10000 }, // 10s timeout for SSRF prevention
      );

      return {
        idToken: response.data.id_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
      };
    } catch (error: any) {
      // Log details server-side, generic message to client
      this.logger.warn(
        `Token refresh failed: ${error?.response?.data?.error?.message || error.message}`,
      );
      throw new BadRequestException('Token refresh failed');
    }
  }

  // ─── Authenticated user endpoints ────────────────────────────────────

  /**
   * Returns the current user's full profile from the database.
   */
  @Get('me')
  @ApiBearerAuth('firebase-auth')
  @ApiOperation({
    summary: 'Get current user profile',
    description: 'Returns the full user profile from the database.',
  })
  async getMe(@Req() req: any) {
    const { dbUser } = req.user;
    return {
      uid: dbUser.uid,
      email: dbUser.email,
      emailVerified: dbUser.emailVerified,
      displayName: dbUser.displayName,
      photoUrl: dbUser.photoUrl,
      provider: dbUser.provider,
      role: dbUser.role,
      requestCount: dbUser.requestCount,
      lastActiveAt: dbUser.lastActiveAt,
      createdAt: dbUser.createdAt,
    };
  }

  // ─── Admin-only endpoints ────────────────────────────────────────────

  /**
   * List all users in the database.
   */
  @Get('users')
  @Roles('admin')
  @ApiBearerAuth('firebase-auth')
  @ApiOperation({
    summary: '[Admin] List all users',
    description: 'Returns paginated list of all users. Admin only.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size (default: 50, max: 100)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Offset (default: 0)',
  })
  async listUsers(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

    return this.usersService.findAll({
      limit: parsedLimit,
      offset: parsedOffset,
    });
  }

  /**
   * Get a specific user by UID.
   */
  @Get('users/:uid')
  @Roles('admin')
  @ApiBearerAuth('firebase-auth')
  @ApiOperation({
    summary: '[Admin] Get user by UID',
    description: 'Returns a specific user profile. Admin only.',
  })
  @ApiParam({ name: 'uid', description: 'Firebase UID' })
  async getUser(@Param('uid') uid: string) {
    const user = await this.usersService.findByUid(uid);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * Disable or re-enable a user account.
   * Cannot disable your own account.
   */
  @Post('users/:uid/disable')
  @Roles('admin')
  @ApiBearerAuth('firebase-auth')
  @ApiOperation({
    summary: '[Admin] Disable/enable user',
    description:
      'Disable or re-enable a user account. Cannot disable your own account. Admin only.',
  })
  @ApiParam({ name: 'uid', description: 'Firebase UID of the target user' })
  async disableUser(
    @Param('uid') uid: string,
    @Body() body: DisableUserDto,
    @Req() req: any,
  ) {
    // Prevent admin self-disable
    if (uid === req.user.uid) {
      throw new ForbiddenException('Cannot disable your own account');
    }

    try {
      const user = await this.usersService.setDisabled(uid, body.disabled);
      this.logger.log(
        `Admin ${req.user.uid} ${body.disabled ? 'disabled' : 'enabled'} user ${uid}`,
      );
      return user;
    } catch (error: any) {
      this.logger.error(`Failed to update user ${uid}: ${error.message}`);
      throw new BadRequestException('Failed to update user status');
    }
  }
}
