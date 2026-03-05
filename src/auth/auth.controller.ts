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
  ConflictException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Public } from './public.decorator';
import { Roles } from './roles.decorator';
import { UsersService } from './users.service';

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
   */
  @Public()
  @Post('register')
  @ApiOperation({
    summary: 'Register a new user',
    description:
      'Creates a Firebase Auth account and a corresponding DB row with the default role of "user". Returns the user profile and Firebase custom token for immediate sign-in.',
  })
  async register(
    @Body()
    body: {
      email: string;
      password: string;
      displayName?: string;
    },
  ) {
    if (!body.email || !body.password) {
      throw new BadRequestException('email and password are required');
    }

    if (body.password.length < 6) {
      throw new BadRequestException('password must be at least 6 characters');
    }

    try {
      const dbUser = await this.usersService.createUser({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
      });

      this.logger.log(`New user registered: ${body.email} (${dbUser.uid})`);

      return {
        uid: dbUser.uid,
        email: dbUser.email,
        displayName: dbUser.displayName,
        role: dbUser.role,
        createdAt: dbUser.createdAt,
        message:
          'Account created. Sign in with Firebase Auth on the client using your email and password to get an ID token.',
      };
    } catch (error: any) {
      if (error.code === 'auth/email-already-exists') {
        throw new ConflictException('A user with this email already exists');
      }
      if (error.code === 'auth/invalid-email') {
        throw new BadRequestException('Invalid email address');
      }
      if (error.code === 'auth/weak-password') {
        throw new BadRequestException(
          'Password is too weak. Use at least 6 characters.',
        );
      }
      this.logger.error(`Registration failed: ${error.message}`);
      throw new BadRequestException(error.message || 'Registration failed');
    }
  }

  /**
   * Exchange a Firebase refresh token for a new ID token.
   * Convenience proxy so clients don't need the Firebase Web API key.
   */
  @Public()
  @Post('refresh')
  @ApiOperation({
    summary: 'Refresh Firebase ID token',
    description:
      'Exchange a Firebase refresh token for a new ID token via the Firebase Auth REST API.',
  })
  async refreshToken(@Body() body: { refreshToken: string }) {
    const apiKey = this.configService.get<string>('FIREBASE_WEB_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'FIREBASE_WEB_API_KEY not set — refresh endpoint unavailable',
      );
      return {
        error:
          'Refresh endpoint not configured. Set FIREBASE_WEB_API_KEY env var.',
      };
    }

    try {
      const response = await axios.post(
        `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
        {
          grant_type: 'refresh_token',
          refresh_token: body.refreshToken,
        },
      );

      return {
        idToken: response.data.id_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
      };
    } catch (error: any) {
      this.logger.warn(
        `Token refresh failed: ${error?.response?.data?.error?.message || error.message}`,
      );
      return {
        error: 'Token refresh failed',
        details: error?.response?.data?.error?.message || error.message,
      };
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
    description:
      'Returns the full user profile from the database, including role, request count, and timestamps.',
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
      disabled: dbUser.disabled,
      requestCount: dbUser.requestCount,
      lastActiveAt: dbUser.lastActiveAt,
      createdAt: dbUser.createdAt,
      updatedAt: dbUser.updatedAt,
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
    description: 'Page size (default: 50)',
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
    return this.usersService.findAll({
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
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
      throw new NotFoundException(`User ${uid} not found`);
    }
    return user;
  }

  /**
   * Disable or re-enable a user account.
   */
  @Post('users/:uid/disable')
  @Roles('admin')
  @ApiBearerAuth('firebase-auth')
  @ApiOperation({
    summary: '[Admin] Disable/enable user',
    description:
      'Disable or re-enable a user account. Disabled users cannot access any endpoint. Admin only.',
  })
  @ApiParam({ name: 'uid', description: 'Firebase UID of the target user' })
  async disableUser(
    @Param('uid') uid: string,
    @Body() body: { disabled: boolean },
  ) {
    if (typeof body.disabled !== 'boolean') {
      throw new BadRequestException('disabled must be a boolean');
    }

    const user = await this.usersService.setDisabled(uid, body.disabled);
    this.logger.log(
      `Admin ${body.disabled ? 'disabled' : 'enabled'} user ${uid}`,
    );
    return user;
  }
}
