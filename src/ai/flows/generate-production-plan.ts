'use server';

import type { PlanConfig, GenerateProductionPlanOutput } from '@/lib/types';
import { runProductionScheduler } from '@/lib/production-scheduler';

/**
 * Server action: Generate a production plan using the parallel scheduler.
 *
 * Validates input, delegates to `runProductionScheduler`, and returns the
 * plan with metrics.
 */
export async function generateProductionPlan(
  input: PlanConfig & {
    freeUpMachineConstraints?: Array<{ machineName: string; startTime: number; endTime: number }>;
  },
): Promise<GenerateProductionPlanOutput> {
  const { partsData, machinesData, productionShiftDuration, breakTime, freeUpMachineConstraints } = input;

  // Validate quantities
  const invalidPart = partsData.find(p => !p.quantityToProduce || p.quantityToProduce <= 0);
  if (invalidPart) {
    return {
      productionPlan: [],
      summary: `Error: Please specify valid quantity to produce for part "${invalidPart.partName}".`,
    };
  }

  const result = runProductionScheduler({
    partsData,
    machinesData,
    productionShiftDuration,
    breakTime,
    freeUpMachineConstraints,
  });

  return {
    productionPlan: result.productionPlan,
    summary: result.summary,
    metrics: result.metrics,
  };
}
