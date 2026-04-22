import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { users } from '../database/schema/users.schema';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private stripe: Stripe | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Inject('DRIZZLE') private readonly db: any,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) {
      this.logger.warn(
        'STRIPE_SECRET_KEY not set — billing features are disabled',
      );
    } else {
      this.stripe = new Stripe(secretKey, { typescript: true });
    }
  }

  /**
   * Returns the Stripe client, throwing if not configured.
   */
  private getStripe(): Stripe {
    if (!this.stripe) {
      throw new Error(
        'Stripe is not configured. Set STRIPE_SECRET_KEY in your environment.',
      );
    }
    return this.stripe;
  }

  // ─── Checkout ─────────────────────────────────────────────────────────

  /**
   * Create a Stripe Checkout Session for a subscription.
   * If the user doesn't have a Stripe customer ID yet, one is created.
   */
  async createCheckoutSession(params: {
    uid: string;
    email: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }> {
    // Ensure user has a Stripe customer ID
    const customerId = await this.getOrCreateStripeCustomer(
      params.uid,
      params.email,
    );

    const session = await this.getStripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: params.priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      subscription_data: {
        metadata: { uid: params.uid },
      },
      metadata: { uid: params.uid },
    });

    return { url: session.url! };
  }

  // ─── Billing Portal ──────────────────────────────────────────────────

  /**
   * Create a Stripe Billing Portal session for the user to manage
   * their subscription, update payment methods, view invoices, etc.
   */
  async createBillingPortalSession(params: {
    uid: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const user = await this.findUser(params.uid);
    if (!user?.stripeCustomerId) {
      throw new Error('No billing account found');
    }

    const session = await this.getStripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: params.returnUrl,
    });

    return { url: session.url };
  }

  // ─── Webhook ──────────────────────────────────────────────────────────

  /**
   * Verify and construct a Stripe webhook event from the raw body.
   */
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const webhookSecret = this.configService.get<string>(
      'STRIPE_WEBHOOK_SECRET',
    );
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    }
    return this.getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      webhookSecret,
    );
  }

  /**
   * Handle a verified Stripe webhook event.
   * Updates the user's subscription status in the database.
   */
  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await this.handleCheckoutComplete(session);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        await this.syncSubscription(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await this.handleSubscriptionDeleted(subscription);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        this.logger.log(
          `Invoice paid: ${invoice.id} for customer ${invoice.customer}`,
        );
        // Subscription status is handled by customer.subscription.updated
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        this.logger.warn(
          `Invoice payment failed: ${invoice.id} for customer ${invoice.customer}`,
        );
        // Subscription status (past_due) is handled by customer.subscription.updated
        break;
      }

      default:
        this.logger.debug(`Unhandled webhook event: ${event.type}`);
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────

  /**
   * After checkout.session.completed, sync the subscription to the DB.
   */
  private async handleCheckoutComplete(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const uid = session.metadata?.uid;
    if (!uid) {
      this.logger.warn(
        `Checkout session ${session.id} has no uid in metadata — skipping`,
      );
      return;
    }

    if (session.subscription) {
      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription.id;

      const subscription =
        await this.getStripe().subscriptions.retrieve(subscriptionId);
      await this.syncSubscription(subscription);
    }

    this.logger.log(`Checkout complete for user ${uid}`);
  }

  /**
   * Sync a Stripe subscription's status to the users table.
   */
  private async syncSubscription(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;

    // Find user by stripeCustomerId
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.stripeCustomerId, customerId))
      .limit(1);

    if (!user) {
      this.logger.warn(
        `No user found for Stripe customer ${customerId} — skipping sync`,
      );
      return;
    }

    // Map Stripe status to our tier + status
    const isActive =
      subscription.status === 'active' ||
      subscription.status === 'trialing';

    // In Stripe SDK v20+, period_end is on subscription items
    const periodEnd = subscription.items?.data?.[0]?.current_period_end;

    const [updated] = await this.db
      .update(users)
      .set({
        stripeSubscriptionId: subscription.id,
        subscriptionTier: isActive ? 'pro' : 'free',
        subscriptionStatus: this.mapStripeStatus(subscription.status),
        subscriptionPeriodEnd: periodEnd
          ? new Date(periodEnd * 1000)
          : null,
        updatedAt: new Date(),
      })
      .where(eq(users.uid, user.uid))
      .returning();

    this.logger.log(
      `Synced subscription for user ${user.uid}: tier=${updated.subscriptionTier}, status=${updated.subscriptionStatus}`,
    );
  }

  /**
   * When a subscription is deleted (canceled), downgrade to free.
   */
  private async handleSubscriptionDeleted(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;

    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.stripeCustomerId, customerId))
      .limit(1);

    if (!user) return;

    await this.db
      .update(users)
      .set({
        subscriptionTier: 'free',
        subscriptionStatus: 'canceled',
        stripeSubscriptionId: null,
        subscriptionPeriodEnd: null,
        updatedAt: new Date(),
      })
      .where(eq(users.uid, user.uid));

    this.logger.log(`Subscription deleted for user ${user.uid} — downgraded to free`);
  }

  /**
   * Get or create a Stripe customer for a user.
   * Stores the stripeCustomerId in the users table.
   */
  private async getOrCreateStripeCustomer(
    uid: string,
    email: string,
  ): Promise<string> {
    const user = await this.findUser(uid);

    if (user?.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    // Create Stripe customer
    const customer = await this.getStripe().customers.create({
      email,
      metadata: { uid },
    });

    // Store in DB
    await this.db
      .update(users)
      .set({
        stripeCustomerId: customer.id,
        updatedAt: new Date(),
      })
      .where(eq(users.uid, uid));

    this.logger.log(
      `Created Stripe customer ${customer.id} for user ${uid}`,
    );

    return customer.id;
  }

  private async findUser(uid: string) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.uid, uid))
      .limit(1);
    return user;
  }

  /**
   * Map Stripe subscription status to our enum values.
   */
  private mapStripeStatus(
    stripeStatus: Stripe.Subscription.Status,
  ): 'none' | 'active' | 'canceled' | 'past_due' | 'trialing' {
    switch (stripeStatus) {
      case 'active':
        return 'active';
      case 'trialing':
        return 'trialing';
      case 'past_due':
        return 'past_due';
      case 'canceled':
      case 'unpaid':
      case 'incomplete_expired':
        return 'canceled';
      default:
        return 'none';
    }
  }
}
