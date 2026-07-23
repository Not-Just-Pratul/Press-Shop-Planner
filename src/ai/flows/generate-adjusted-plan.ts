'use server';

import type { Part, Machine, ProductionPlanItem, GenerateAdjustedPlanOutput } from '@/lib/types';
import { runProductionScheduler } from '@/lib/production-scheduler';

export async function generateAdjustedPlan(
  input: {
    partsData: (Part & { actualQuantityProduced?: number })[];
    machinesData: Machine[];
    productionShiftDuration: number;
    elapsedTimeSinceShiftStart: number;
    currentProductionPlan: { productionPlan: ProductionPlanItem[]; summary: string };
    breakTime?: { start: number; end: number };
    historicalProductionData?: string;
    freeUpMachineConstraints?: Array<{ machineName: string; startTime: number; endTime: number }>;
  }
): Promise<GenerateAdjustedPlanOutput> {
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
