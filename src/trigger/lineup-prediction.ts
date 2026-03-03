import { task, logger } from '@trigger.dev/sdk/v3';
import { generatePredictionTask } from './generate-prediction';
import { initServices } from './init';
import { eq, and, gte, lte, asc, isNull, sql } from 'drizzle-orm';
import * as schema from '../database/schema';

/**
 * Re-generate predictions when confirmed lineups become available.
 *
 * Lineups are typically published ~60 minutes before kickoff on API-Football.
 * The daily prediction (generated up to 48h early) and even the initial
 * pre_match prediction may have been created without lineup data.
 *
 * This task:
 *  1. Finds fixtures starting within 90 minutes that have status=NS
 *  2. For each, checks if an existing pre_match prediction was made without lineups
 *     (matchContext.lineupsAvailable = false)
 *  3. Probes the API-Football lineups endpoint to see if lineups are now available
 *  4. If lineups ARE available, re-triggers the prediction pipeline — the existing
 *     pre_match prediction is upserted (overwritten) with the lineup-enriched version
 *  5. If no pre_match prediction exists yet at all, generates one (covers the case
 *     where the pre-match schedule hasn't run yet but lineups are already out)
 *
 * Scheduled: Every 5 minutes (more granular than the 15-min pre-match window
 * to catch lineups as soon as they appear)
 */
export const lineupPredictionTask = task({
  id: 'lineup-aware-prediction',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async () => {
    const { db, footballService, alertsService } = initServices();

    const now = new Date();
    // Check fixtures within the next 90 minutes — lineups can appear
    // anywhere from ~75min to ~30min before kickoff
    const windowEnd = new Date(now.getTime() + 90 * 60 * 1000);

    // Get upcoming fixtures in the window
    const fixtures = await db
      .select()
      .from(schema.fixtures)
      .where(
        and(
          eq(schema.fixtures.status, 'NS'),
          gte(schema.fixtures.date, now),
          lte(schema.fixtures.date, windowEnd),
        ),
      )
      .orderBy(asc(schema.fixtures.date));

    if (fixtures.length === 0) {
      return { checked: 0, regenerated: 0, newlyGenerated: 0, skipped: 0 };
    }

    logger.info(`Checking ${fixtures.length} fixtures for lineup availability`);

    const fixtureIdsToRegenerate: number[] = [];
    const fixtureIdsToGenerate: number[] = [];
    const fixturesWithNewLineups: Array<{
      id: number;
      leagueName: string | null;
      homeTeamId: number;
      awayTeamId: number;
    }> = [];
    let skipped = 0;

    for (const fixture of fixtures) {
      // Check if a pre_match prediction already exists
      const existing = await db
        .select({
          id: schema.predictions.id,
          matchContext: schema.predictions.matchContext,
        })
        .from(schema.predictions)
        .where(
          and(
            eq(schema.predictions.fixtureId, fixture.id),
            eq(schema.predictions.predictionType, 'pre_match'),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        const prediction = existing[0];
        const context = prediction.matchContext as Record<string, any> | null;

        // Already has lineups — no need to regenerate
        if (context?.lineupsAvailable === true) {
          skipped++;
          continue;
        }

        // Prediction exists but was made without lineups — check if lineups
        // are now available from the API. Persist them to DB if found.
        try {
          const persisted = await footballService.fetchAndPersistLineups(
            fixture.id,
          );
          if (persisted > 0) {
            logger.info(
              `Lineups now available for fixture ${fixture.id} — persisted and will regenerate pre_match prediction`,
            );
            fixtureIdsToRegenerate.push(fixture.id);
            fixturesWithNewLineups.push({
              id: fixture.id,
              leagueName: fixture.leagueName,
              homeTeamId: fixture.homeTeamId,
              awayTeamId: fixture.awayTeamId,
            });
          } else {
            skipped++;
          }
        } catch {
          // API call failed — skip, will retry next cycle
          skipped++;
        }
      } else {
        // No pre_match prediction exists yet — check if lineups are available
        // so we can generate one WITH lineup data from the start
        try {
          const persisted = await footballService.fetchAndPersistLineups(
            fixture.id,
          );
          if (persisted > 0) {
            logger.info(
              `Lineups available for fixture ${fixture.id} — persisted and generating pre_match prediction with lineups`,
            );
            fixtureIdsToGenerate.push(fixture.id);
            fixturesWithNewLineups.push({
              id: fixture.id,
              leagueName: fixture.leagueName,
              homeTeamId: fixture.homeTeamId,
              awayTeamId: fixture.awayTeamId,
            });
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
      }
    }

    const allFixtureIds = [...fixtureIdsToRegenerate, ...fixtureIdsToGenerate];

    if (allFixtureIds.length === 0) {
      logger.info(
        `No fixtures need lineup-based prediction (${skipped} skipped)`,
      );
      return {
        checked: fixtures.length,
        regenerated: 0,
        newlyGenerated: 0,
        skipped,
      };
    }

    // Trigger prediction generation for all fixtures that need it.
    // The storePrediction upsert will overwrite the existing pre_match
    // prediction with the new lineup-enriched version.
    const batchResult = await generatePredictionTask.batchTriggerAndWait(
      allFixtureIds.map((fixtureId) => ({
        payload: { fixtureId, predictionType: 'pre_match' as const },
      })),
    );

    let regenerated = 0;
    let newlyGenerated = 0;
    let failed = 0;

    for (let i = 0; i < batchResult.runs.length; i++) {
      const run = batchResult.runs[i];
      const fixtureId = allFixtureIds[i];
      const isRegeneration = fixtureIdsToRegenerate.includes(fixtureId);

      if (run.ok) {
        if (isRegeneration) regenerated++;
        else newlyGenerated++;
      } else {
        failed++;
        logger.error('Lineup prediction run failed', {
          taskRunId: run.id,
          fixtureId,
          isRegeneration,
        });
      }
    }

    // Fire lineup_change alerts for fixtures that got new lineups
    for (const f of fixturesWithNewLineups) {
      try {
        // Fetch persisted lineups to include formation info in alert
        const lineups = await footballService.getLineupsForFixture(f.id);
        const homeLineup = lineups.find((l: any) => l.teamId === f.homeTeamId);
        const awayLineup = lineups.find((l: any) => l.teamId === f.awayTeamId);

        const homeName = homeLineup?.teamName ?? 'Home';
        const awayName = awayLineup?.teamName ?? 'Away';
        const matchTitle = `${homeName} vs ${awayName}`;

        await alertsService.createLineupAlert(f.id, matchTitle, {
          homeFormation: homeLineup?.formation ?? undefined,
          awayFormation: awayLineup?.formation ?? undefined,
          homeTeam: homeName,
          awayTeam: awayName,
        });
      } catch (err) {
        logger.warn(`Failed to create lineup alert for fixture ${f.id}`, {
          error: (err as Error).message,
        });
      }
    }

    logger.info('Lineup-aware prediction task complete', {
      checked: fixtures.length,
      regenerated,
      newlyGenerated,
      skipped,
      failed,
      alertsCreated: fixturesWithNewLineups.length,
    });

    return {
      checked: fixtures.length,
      regenerated,
      newlyGenerated,
      skipped,
      failed,
      alertsCreated: fixturesWithNewLineups.length,
    };
  },
});
