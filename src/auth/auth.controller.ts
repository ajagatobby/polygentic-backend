import { Body, Controller, Get, Post, Req, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Public } from './public.decorator';

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Exchange a Firebase refresh token for a new ID token.
   * This is a convenience proxy so the mobile/web client doesn't need to
   * know the Firebase Web API key or hit Google's endpoint directly.
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

  /**
   * Returns the currently authenticated user's info from the Firebase token.
   * Requires a valid Bearer token.
   */
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get current user',
    description: 'Returns decoded Firebase user info from the Bearer token.',
  })
  async getMe(@Req() req: any) {
    return {
      uid: req.user.uid,
      email: req.user.email,
      emailVerified: req.user.emailVerified,
      displayName: req.user.displayName,
      picture: req.user.picture,
    };
  }
}
