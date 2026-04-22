import {
  Controller,
  Post,
  Body,
  Req,
  RawBodyRequest,
  Logger,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { IsString, IsUrl } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { BillingService } from './billing.service';

// ─── DTOs ──────────────────────────────────────────────────────────────

class CreateCheckoutDto {
  @IsString()
  priceId: string;

  @IsUrl({ require_tld: false })
  successUrl: string;

  @IsUrl({ require_tld: false })
  cancelUrl: string;
}

class CreatePortalDto {
  @IsUrl({ require_tld: false })
  returnUrl: string;
}

// ─── Controller ────────────────────────────────────────────────────────

@ApiTags('Billing')
@Controller('api/billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(private readonly billingService: BillingService) {}

  // ─── Checkout Session ─────────────────────────────────────────────

  /**
   * Create a Stripe Checkout Session for a subscription.
   * Requires an authenticated user.
   */
  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('firebase-auth')
  @ApiOperation({
    summary: 'Create Stripe checkout session',
    description:
      'Creates a Stripe Checkout Session for subscription. Returns the checkout URL.',
  })
  async createCheckout(
    @Body() body: CreateCheckoutDto,
    @Req() req: any,
  ) {
    try {
      const { dbUser } = req.user;
      const result = await this.billingService.createCheckoutSession({
        uid: dbUser.uid,
        email: dbUser.email,
        priceId: body.priceId,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
      });
      return result;
    } catch (error: any) {
      this.logger.error(`Checkout creation failed: ${error.message}`);
      throw new BadRequestException('Failed to create checkout session');
    }
  }

  // ─── Billing Portal ───────────────────────────────────────────────

  /**
   * Create a Stripe Billing Portal session for the user
   * to manage their subscription.
   */
  @Post('portal')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('firebase-auth')
  @ApiOperation({
    summary: 'Create billing portal session',
    description:
      'Creates a Stripe Billing Portal session. Returns the portal URL.',
  })
  async createPortal(
    @Body() body: CreatePortalDto,
    @Req() req: any,
  ) {
    try {
      const { dbUser } = req.user;
      const result = await this.billingService.createBillingPortalSession({
        uid: dbUser.uid,
        returnUrl: body.returnUrl,
      });
      return result;
    } catch (error: any) {
      this.logger.error(`Portal creation failed: ${error.message}`);
      throw new BadRequestException(
        error.message === 'No billing account found'
          ? 'No billing account found. Subscribe first.'
          : 'Failed to create billing portal session',
      );
    }
  }

  // ─── Webhook ──────────────────────────────────────────────────────

  /**
   * Stripe webhook endpoint.
   * MUST be public (no auth) — Stripe calls this directly.
   * Uses raw body for signature verification.
   */
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stripe webhook',
    description:
      'Receives Stripe webhook events. Public endpoint — verified via webhook signature.',
  })
  async handleWebhook(@Req() req: RawBodyRequest<Request>) {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException(
        'Raw body not available — ensure rawBody: true is set in NestFactory.create()',
      );
    }

    let event;
    try {
      event = this.billingService.constructWebhookEvent(rawBody, signature);
    } catch (error: any) {
      this.logger.warn(
        `Webhook signature verification failed: ${error.message}`,
      );
      throw new BadRequestException('Invalid webhook signature');
    }

    try {
      await this.billingService.handleWebhookEvent(event);
    } catch (error: any) {
      this.logger.error(`Webhook handler error: ${error.message}`);
      // Return 200 anyway to prevent Stripe from retrying
      // (we log the error for investigation)
    }

    return { received: true };
  }
}
