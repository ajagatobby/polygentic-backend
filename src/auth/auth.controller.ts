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
   * Set a user's role (user or admin).
   * Also syncs to Firebase custom claims.
   */
  @Post('users/:uid/role')
  @Roles('admin')
  @ApiBearerAuth('firebase-auth')
  @ApiOperation({
    summary: '[Admin] Set user role',
    description:
      'Set a user\'s role to "user" or "admin". Syncs to Firebase custom claims. Admin only.',
  })
  @ApiParam({ name: 'uid', description: 'Firebase UID of the target user' })
  async setUserRole(
    @Param('uid') uid: string,
    @Body() body: { role: 'user' | 'admin' },
  ) {
    if (!body.role || !['user', 'admin'].includes(body.role)) {
      throw new BadRequestException('role must be "user" or "admin"');
    }

    const user = await this.usersService.setRole(uid, body.role);
    this.logger.log(`Admin set role '${body.role}' for user ${uid}`);
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
