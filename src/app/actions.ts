'use server';

import { generateProductionPlan } from '@/ai/flows/generate-production-plan';
import { generateAdjustedPlan } from '@/ai/flows/generate-adjusted-plan';
import { generatePlanInsights } from '@/ai/flows/generate-plan-insights';
import { generateDiscrepancyReport } from '@/ai/flows/generate-discrepancy-report';
import type { PlanConfig, GenerateProductionPlanOutput, PlanInsightsOutput, DiscrepancyReportOutput, GenerateAdjustedPlanOutput, ProductionPlanItem } from '@/lib/types';

export async function getProductionPlan(
  input: PlanConfig
): Promise<{ data: { plan: GenerateProductionPlanOutput; insights: PlanInsightsOutput | null; discrepancyReport: DiscrepancyReportOutput | null } | null; error: string | null }> {
  try {
    const planOutput = await generateProductionPlan(input);

    if (!planOutput) {
      return { data: null, error: 'Failed to generate a plan.' };
    }

    if (planOutput.summary.startsWith('Error:')) {
      return { data: null, error: planOutput.summary };
    }

    if (planOutput.productionPlan.length === 0 && !planOutput.summary.startsWith('Error:')) {
      return { data: null, error: 'The generated plan is empty. Please check your input data and try again.' };
    }

    const insightsConfig: PlanConfig = {
      partsData: input.partsData,
      machinesData: input.machinesData,
      productionShiftDuration: input.productionShiftDuration,
      historicalProductionData: input.historicalProductionData,
    };

    const insightsInput = {
      plan: planOutput,
      config: insightsConfig,
    };

    const [insightsOutput, discrepancyReportOutput] = await Promise.all([
      generatePlanInsights(insightsInput),
      generateDiscrepancyReport(insightsInput)
    ]);

    return {
      data: {
        plan: planOutput,
        insights: insightsOutput || null,
        discrepancyReport: discrepancyReportOutput || null
      },
      error: null
    };
  } catch (e) {
    console.error(e);
    const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred.';
    return { data: null, error: `An unexpected error occurred: ${errorMessage}` };
  }
}

export async function getAdjustedProductionPlan(
  input: {
    partsData: PlanConfig['partsData'];
    machinesData: PlanConfig['machinesData'];
    productionShiftDuration: number;
    elapsedTimeSinceShiftStart: number;
    currentProductionPlan: { productionPlan: ProductionPlanItem[]; summary: string };
    breakTime?: { start: number; end: number };
    historicalProductionData?: string;
  }
): Promise<{ data: { plan: GenerateAdjustedPlanOutput; insights: PlanInsightsOutput; discrepancyReport: DiscrepancyReportOutput | null } | null; error: string | null }> {
  try {
    const planOutput = await generateAdjustedPlan(input);

    if (!planOutput || !planOutput.productionPlan) {
      return { data: null, error: 'Failed to generate an adjusted plan.' };
    }

    const insightsConfig: PlanConfig = {
      partsData: input.partsData,
      machinesData: input.machinesData,
      productionShiftDuration: input.productionShiftDuration,
      historicalProductionData: input.historicalProductionData,
    };

    const insightsInput = {
      plan: planOutput,
      config: insightsConfig,
    };

    const [insightsOutput, discrepancyReportOutput] = await Promise.all([
      generatePlanInsights(insightsInput),
      generateDiscrepancyReport(insightsInput)
    ]);

    if (!insightsOutput) {
      return { data: null, error: 'The adjusted plan was generated, but insights could not be created.' };
    }

    return {
      data: {
        plan: planOutput,
        insights: insightsOutput,
        discrepancyReport: discrepancyReportOutput || null
      },
      error: null
    };
  } catch (e) {
    console.error(e);
    const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred.';
    return { data: null, error: `An unexpected error occurred: ${errorMessage}` };
  }
}
