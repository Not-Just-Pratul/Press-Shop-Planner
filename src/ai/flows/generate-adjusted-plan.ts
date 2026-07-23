'use server';

import type { Part, Machine, ProductionPlanItem, GenerateAdjustedPlanOutput } from '@/lib/types';
import { runProductionScheduler } from '@/lib/production-scheduler';

/**
 * Server action: Generate an adjusted production plan.
 *
 * Takes the current plan, actual quantities produced, and a re-plan time,
 * then re-schedules remaining work using the parallel scheduler.
 */
export async function generateAdjustedPlan(input: {
  partsData: (Part & { actualQuantityProduced?: number })[];
  machinesData: Machine[];
  productionShiftDuration: number;
  elapsedTimeSinceShiftStart: number;
  currentProductionPlan: { productionPlan: ProductionPlanItem[]; summary: string };
  breakTime?: { start: number; end: number };
  historicalProductionData?: string;
  freeUpMachineConstraints?: Array<{ machineName: string; startTime: number; endTime: number }>;
}): Promise<GenerateAdjustedPlanOutput> {
  const {
    partsData,
    machinesData,
    productionShiftDuration,
    elapsedTimeSinceShiftStart,
    currentProductionPlan,
    breakTime,
    freeUpMachineConstraints,
  } = input;

  const result = runProductionScheduler({
    partsData,
    machinesData,
    productionShiftDuration,
    breakTime,
    freeUpMachineConstraints,
    elapsedTimeSinceShiftStart,
    currentProductionPlan,
  });

  return {
    productionPlan: result.productionPlan,
    summary: result.summary,
    metrics: result.metrics,
  };
}
