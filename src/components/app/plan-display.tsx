"use client";

import { useState, useMemo } from "react";
import type { ProductionPlan, Machine, PlanInsights, ProductionPlanItem, ProductionPlanMetrics, PartScheduleStatus } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, BarChart2, GanttChartSquare, CheckCircle2, Clock, AlertTriangle, Layers, Filter, Info } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import * as XLSX from "xlsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent } from "@/components/ui/chart";
import { Bar, BarChart, XAxis, YAxis, LabelList } from "recharts";
import { formatMinutesToClockTime } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface PlanDisplayProps {
  plan: ProductionPlan | null;
  insights: PlanInsights | null;
  isLoading: boolean;
  machines: Machine[];
  shiftDuration: number;
  shiftStartTime: string;
}

/** Helper to get badge color based on part schedule status */
function getStatusColor(status: string): { badge: string } {
  switch (status) {
    case 'Completed':
      return { badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20' };
    case 'In Progress':
      return { badge: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20' };
    case 'Scheduled Partially':
      return { badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20' };
    case 'Waiting for Previous Process':
      return { badge: 'bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20' };
    case 'Waiting for Machine':
      return { badge: 'bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20' };
    case 'Could Not Be Fully Scheduled in Current Shift':
      return { badge: 'bg-destructive/10 text-destructive border-destructive/20' };
    default:
      return { badge: 'bg-muted/10 text-muted-foreground border-muted/20' };
  }
}

export function PlanDisplay({
  plan,
  insights,
  isLoading,
  machines,
  shiftDuration,
  shiftStartTime = "09:00",
}: PlanDisplayProps) {
  const formatTime = useMemo(
    () => (minutes: number) => formatMinutesToClockTime(shiftStartTime, minutes),
    [shiftStartTime]
  );

  if (isLoading) {
    return <PlanDisplaySkeleton />;
  }

  if (!plan || !plan.productionPlan) {
    return (
      <div className="flex flex-col items-center justify-center text-center p-8 border rounded-xl h-full min-h-[50vh] bg-card/50 shadow-sm">
        <GanttChartSquare className="h-16 w-16 text-muted-foreground/60 mb-4 animate-pulse" />
        <h3 className="text-2xl font-bold font-headline mb-2">No Plan Generated</h3>
        <p className="text-muted-foreground max-w-md">
          Select parts and machines from the configuration panel, then click "Generate Production Plan" to build your schedule.
        </p>
      </div>
    );
  }

  // Derive metrics if plan.metrics is missing
  const metrics: ProductionPlanMetrics = plan.metrics || {
    totalPartsRequired: plan.productionPlan.reduce((acc, p) => acc + p.quantity, 0),
    totalPartsProduced: plan.productionPlan.filter(p => p.taskType === 'Production').reduce((acc, p) => acc + p.quantity, 0),
    totalPartsRemaining: 0,
    fullyCompletedPartsCount: new Set(plan.productionPlan.map(p => p.partName)).size,
    totalPartsCount: new Set(plan.productionPlan.map(p => p.partName)).size,
    incompletePartsCount: 0,
    overallProgressPercentage: 100,
    estimatedCompletionTimeMinutes: Math.max(0, ...plan.productionPlan.map(p => p.endTime)),
    pendingOperations: [],
  };

  return (
    <div className="space-y-6">
      {/* Plan Header & Summary Metrics */}
      <Card className="border shadow-sm bg-card">
        <CardHeader className="border-b bg-muted/20 pb-4">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-xl font-bold font-headline">Production Plan Overview</CardTitle>
                <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 font-mono">
                  {shiftStartTime} - {formatTime(shiftDuration)} ({shiftDuration} mins)
                </Badge>
              </div>
              <CardDescription className="mt-1">{plan.summary}</CardDescription>
            </div>
            <PlanActions plan={plan} insights={insights} shiftDuration={shiftDuration} allMachines={machines} formatTime={formatTime} />
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          {/* Summary KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <div className="p-4 rounded-lg bg-muted/40 border">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Parts Required</span>
              <p className="text-2xl font-bold mt-1 text-foreground">{metrics.totalPartsRequired}</p>
            </div>
            <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400 uppercase tracking-wider">Parts Completed</span>
              <p className="text-2xl font-bold mt-1 text-emerald-700 dark:text-emerald-400">{metrics.totalPartsProduced}</p>
            </div>
            <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <span className="text-xs font-medium text-amber-700 dark:text-amber-400 uppercase tracking-wider">Parts Remaining</span>
              <p className="text-2xl font-bold mt-1 text-amber-700 dark:text-amber-400">{metrics.totalPartsRemaining}</p>
            </div>
            <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <span className="text-xs font-medium text-blue-700 dark:text-blue-400 uppercase tracking-wider">Progress</span>
              <p className="text-2xl font-bold mt-1 text-blue-700 dark:text-blue-400">{metrics.overallProgressPercentage}%</p>
            </div>
            <div className="p-4 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <span className="text-xs font-medium text-purple-700 dark:text-purple-400 uppercase tracking-wider">Completed Parts</span>
              <p className="text-2xl font-bold mt-1 text-purple-700 dark:text-purple-400">{metrics.fullyCompletedPartsCount} / {metrics.totalPartsCount}</p>
            </div>
            <div className="p-4 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
              <span className="text-xs font-medium text-indigo-700 dark:text-indigo-400 uppercase tracking-wider">Est. Completion</span>
              <p className="text-xl font-bold mt-1 text-indigo-700 dark:text-indigo-400">{formatTime(metrics.estimatedCompletionTimeMinutes)}</p>
            </div>
          </div>

          {/* Pending Operations Alert */}
          {metrics.pendingOperations && metrics.pendingOperations.length > 0 && (
            <div className="mt-4 p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold text-destructive">Pending / Unscheduled Operations ({metrics.pendingOperations.length})</h4>
                <ul className="text-xs text-muted-foreground mt-1 space-y-1">
                  {metrics.pendingOperations.map((op, idx) => (
                    <li key={idx}>
                      <span className="font-semibold text-foreground">{op.partName} - {op.operationName}:</span> {op.reason}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Part Schedule Statuses */}
          {plan.partStatuses && plan.partStatuses.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Info className="h-4 w-4 text-primary" />
                Part Schedule Status
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {plan.partStatuses.map((ps) => {
                  const statusColor = getStatusColor(ps.status);
                  return (
                    <div key={ps.partName} className="p-3 rounded-lg border bg-card/50 flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-sm">{ps.partName}</span>
                        <Badge className={`text-[10px] px-2 py-0 ${statusColor.badge}`}>
                          {ps.status}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Operations: {ps.completedOperations} / {ps.totalOperations}</span>
                        <span>Remaining: {ps.remainingQuantity} / {ps.totalQuantity}</span>
                      </div>
                      {ps.status !== 'Completed' && ps.status !== 'In Progress' && (
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-0.5">
                          <Clock className="h-3 w-3" />
                          <span>{ps.status === 'Waiting for Machine' ? 'Awaiting machine availability' : ps.status === 'Waiting for Previous Process' ? 'Waiting for prior operation to complete' : ps.status === 'Could Not Be Fully Scheduled in Current Shift' ? 'Insufficient shift time remaining' : ''}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Main Tabs: Gantt Chart & Dashboard */}
      <Tabs defaultValue="gantt" className="w-full">
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="gantt">
            <GanttChartSquare className="mr-2 h-4 w-4" />
            Gantt Chart Timeline
          </TabsTrigger>
          <TabsTrigger value="dashboard">
            <BarChart2 className="mr-2 h-4 w-4" />
            Analytics Dashboard
          </TabsTrigger>
        </TabsList>

        <TabsContent value="gantt" className="mt-4">
          <InteractiveGanttChart
            plan={plan}
            machines={machines}
            shiftDuration={shiftDuration}
            shiftStartTime={shiftStartTime}
            formatTime={formatTime}
          />
        </TabsContent>

        <TabsContent value="dashboard" className="mt-4">
          <Dashboard insights={insights} metrics={metrics} machines={machines} shiftDuration={shiftDuration} formatTime={formatTime} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * High-Precision Interactive Gantt Chart Timeline Component
 */
function InteractiveGanttChart({
  plan,
  machines,
  shiftDuration,
  shiftStartTime,
  formatTime,
}: {
  plan: ProductionPlan;
  machines: Machine[];
  shiftDuration: number;
  shiftStartTime: string;
  formatTime: (minutes: number) => string;
}) {
  const [filterPart, setFilterPart] = useState('');
  const [filterMachine, setFilterMachine] = useState('');

  const { productionPlan } = plan;

  // Filter tasks based on search criteria
  const filteredTasks = useMemo(() => {
    return productionPlan.filter(task => {
      const matchPart = !filterPart || task.partName.toLowerCase().includes(filterPart.toLowerCase());
      const matchMachine = !filterMachine || task.machineName === filterMachine;
      return matchPart && matchMachine;
    });
  }, [productionPlan, filterPart, filterMachine]);

  // Generate hourly tick marks for timeline header
  const timeTicks = useMemo(() => {
    const ticks: Array<{ minutes: number; label: string }> = [];
    const step = shiftDuration <= 240 ? 30 : 60; // 30-min steps for short shifts, 60-min for long
    for (let m = 0; m <= shiftDuration; m += step) {
      ticks.push({ minutes: m, label: formatTime(m) });
    }
    return ticks;
  }, [shiftDuration, formatTime]);

  // Color generator for distinct part task styling
  const getPartColors = (partName: string, taskType: 'Die Setting' | 'Production') => {
    let hash = 0;
    for (let i = 0; i < partName.length; i++) {
      hash = partName.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash % 360);

    if (taskType === 'Die Setting') {
      return {
        bg: `hsl(${hue}, 70%, 95%)`,
        border: `hsl(${hue}, 50%, 75%)`,
        text: `hsl(${hue}, 80%, 25%)`,
        badgeBg: `hsl(${hue}, 60%, 85%)`,
      };
    }

    return {
      bg: `hsl(${hue}, 85%, 90%)`,
      border: `hsl(${hue}, 65%, 70%)`,
      text: `hsl(${hue}, 90%, 20%)`,
      badgeBg: `hsl(${hue}, 75%, 80%)`,
    };
  };

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" />
            Machine Execution Schedule
          </CardTitle>
          <CardDescription>
            Visual Gantt timeline showing continuous operation sequencing and break windows.
          </CardDescription>
        </div>

        {/* Filter Bar */}
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Input
            placeholder="Filter part..."
            value={filterPart}
            onChange={(e) => setFilterPart(e.target.value)}
            className="h-8 w-36 text-xs"
          />
          <select
            value={filterMachine}
            onChange={(e) => setFilterMachine(e.target.value)}
            aria-label="Filter by machine"
            className="h-8 text-xs border rounded-md px-2 bg-background"
          >
            <option value="">All Machines</option>
            {machines.map(m => (
              <option key={m.id} value={m.machineName}>{m.machineName}</option>
            ))}
          </select>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="relative overflow-x-auto border-t">
          <div className="min-w-[900px]">
            {/* Timeline Header Row */}
            <div className="grid grid-cols-[180px_1fr] border-b bg-muted/40 sticky top-0 z-20">
              <div className="p-3 font-semibold text-xs text-muted-foreground border-r flex items-center bg-muted/60">
                Machine / Press
              </div>
              <div className="relative h-10 flex items-center">
                {timeTicks.map((tick, idx) => {
                  const leftPct = (tick.minutes / shiftDuration) * 100;
                  return (
                    <div
                      key={idx}
                      className="absolute transform -translate-x-1/2 flex flex-col items-center text-[10px] font-mono text-muted-foreground"
                      style={{ left: `${leftPct}%` }}
                    >
                      <span className="h-2 w-px bg-border mb-1" />
                      {tick.label}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Machine Rows */}
            {machines.map((machine) => {
              const machineTasks = filteredTasks.filter(t => t.machineName === machine.machineName);

              return (
                <div key={machine.id} className="grid grid-cols-[180px_1fr] border-b min-h-[80px] hover:bg-muted/10 transition-colors">
                  {/* Left Column: Machine Details */}
                  <div className="p-3 border-r bg-card/60 flex flex-col justify-center gap-1 z-10">
                    <span className="font-bold text-sm text-foreground">{machine.machineName}</span>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {machine.capacity}T
                      </Badge>
                      {!machine.available ? (
                        <Badge variant="destructive" className="text-[10px] px-1 py-0">Offline</Badge>
                      ) : machineTasks.length === 0 ? (
                        <span className="text-[10px] text-muted-foreground">Idle</span>
                      ) : (
                        <span className="text-[10px] text-emerald-600 font-medium">{machineTasks.length} tasks</span>
                      )}
                    </div>
                  </div>

                  {/* Right Column: Timeline Canvas */}
                  <div className="relative h-full flex items-center p-2 min-h-[80px]">
                    {/* Time Grid Lines */}
                    {timeTicks.map((tick, idx) => (
                      <div
                        key={idx}
                        className="absolute top-0 bottom-0 border-l border-border/30 pointer-events-none"
                        style={{ left: `${(tick.minutes / shiftDuration) * 100}%` }}
                      />
                    ))}

                    {/* Render Tasks */}
                    {machineTasks.map((task, itemIdx) => {
                      const leftPct = (task.startTime / shiftDuration) * 100;
                      const widthPct = Math.max(1.5, ((task.endTime - task.startTime) / shiftDuration) * 100);
                      const colors = getPartColors(task.partName, task.taskType);
                      const duration = task.endTime - task.startTime;

                      return (
                        <Popover key={`${task.executionOrder}-${itemIdx}`}>
                          <PopoverTrigger asChild>
                            <div
                              className="absolute top-2 bottom-2 rounded-md p-1.5 shadow-sm border text-xs cursor-pointer hover:ring-2 hover:ring-primary/40 transition-all flex flex-col justify-between overflow-hidden"
                              style={{
                                left: `${leftPct}%`,
                                width: `${widthPct}%`,
                                backgroundColor: colors.bg,
                                borderColor: colors.border,
                                color: colors.text,
                              }}
                            >
                              <div className="flex items-center justify-between gap-1">
                                <span className="font-bold truncate text-[11px]">
                                  {task.executionOrder ? `#${task.executionOrder} ` : ''}{task.partName}
                                </span>
                                {task.taskType === 'Die Setting' && (
                                  <Badge className="text-[9px] px-1 py-0 h-4 bg-amber-500/20 text-amber-900 border-amber-500/30">
                                    Setup
                                  </Badge>
                                )}
                              </div>
                              <div className="flex items-center justify-between text-[10px] opacity-90">
                                <span className="truncate">{task.taskType === 'Production' ? task.operationName : 'Die Setting'}</span>
                                <span className="font-mono">{duration}m</span>
                              </div>
                            </div>
                          </PopoverTrigger>
                          <PopoverContent className="w-64 p-3 space-y-2 text-xs">
                            <div className="flex items-center justify-between border-b pb-1">
                              <span className="font-bold text-sm text-foreground">{task.partName}</span>
                              <Badge variant={task.taskType === 'Production' ? 'default' : 'secondary'}>
                                {task.taskType}
                              </Badge>
                            </div>
                            <div className="space-y-1 text-muted-foreground">
                              <p><strong className="text-foreground">Execution Order:</strong> #{task.executionOrder || 'N/A'}</p>
                              <p><strong className="text-foreground">Operation:</strong> {task.operationName}</p>
                              <p><strong className="text-foreground">Machine:</strong> {task.machineName}</p>
                              <p><strong className="text-foreground">Time Slot:</strong> {formatTime(task.startTime)} - {formatTime(task.endTime)} ({duration} mins)</p>
                              {task.taskType === 'Production' && (
                                <p><strong className="text-foreground">Quantity Produced:</strong> {task.quantity} units</p>
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Analytics Dashboard with Machine Utilization, Part Summaries & Machine Table
 */
function Dashboard({
  insights,
  metrics,
  machines,
  shiftDuration,
  formatTime,
}: {
  insights: PlanInsights | null;
  metrics: ProductionPlanMetrics;
  machines: Machine[];
  shiftDuration: number;
  formatTime: (minutes: number) => string;
}) {
  if (!insights) {
    return (
      <div className="flex flex-col items-center justify-center text-center min-h-[300px] bg-card rounded-lg p-6 border">
        <BarChart2 className="h-12 w-12 text-muted-foreground mb-4 animate-spin" />
        <p className="text-muted-foreground">Generating analytics dashboard...</p>
      </div>
    );
  }

  const { machineUtilization, partProduction } = insights;

  const chartConfig = {
    targetQuantity: { label: "Target", color: "hsl(var(--muted-foreground) / 0.4)" },
    quantityProduced: { label: "Produced", color: "hsl(var(--primary))" },
  } satisfies import("@/components/ui/chart").ChartConfig;

  return (
    <div className="space-y-6">
      {/* Visual Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-bold">Part Production vs Target</CardTitle>
            <CardDescription>Comparison of units planned vs target quantities.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={chartConfig} className="h-[320px] w-full">
              <BarChart data={partProduction} layout="vertical" margin={{ left: 10, right: 30 }}>
                <XAxis type="number" />
                <YAxis dataKey="partName" type="category" width={110} tickLine={false} axisLine={false} className="text-xs" />
                <ChartTooltip content={<ChartTooltipContent hideLabel />} cursor={false} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="targetQuantity" fill="var(--color-targetQuantity)" radius={4}>
                  <LabelList position="right" offset={8} className="fill-muted-foreground" fontSize={11} />
                </Bar>
                <Bar dataKey="quantityProduced" fill="var(--color-quantityProduced)" radius={4}>
                  <LabelList position="right" offset={8} className="fill-foreground font-bold" fontSize={11} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card className="border shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-bold">Machine Utilization (%)</CardTitle>
            <CardDescription>Percentage of active working time per machine during shift.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={{}} className="h-[320px] w-full">
              <BarChart data={machineUtilization} layout="vertical" margin={{ left: 10, right: 30 }}>
                <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                <YAxis dataKey="machineName" type="category" width={110} tickLine={false} axisLine={false} className="text-xs" />
                <ChartTooltip content={<ChartTooltipContent hideLabel />} cursor={false} />
                <Bar dataKey="utilizationPercentage" fill="hsl(var(--primary))" radius={4}>
                  <LabelList position="right" offset={8} className="fill-foreground font-bold" fontSize={11} formatter={(v: number) => `${v.toFixed(1)}%`} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Machine Progress Table */}
      <Card className="border shadow-sm">
        <CardHeader>
          <CardTitle className="text-base font-bold">Machine Performance Breakdown</CardTitle>
          <CardDescription>Detailed stats for every press machine in the shop.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Machine</TableHead>
                  <TableHead>Capacity</TableHead>
                  <TableHead>Active Working Time</TableHead>
                  <TableHead>Idle Time</TableHead>
                  <TableHead>Utilization (%)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {machineUtilization.map((m) => {
                  const macObj = machines.find(x => x.machineName === m.machineName);
                  return (
                    <TableRow key={m.machineName}>
                      <TableCell className="font-bold">{m.machineName}</TableCell>
                      <TableCell>{macObj?.capacity ? `${macObj.capacity}T` : 'N/A'}</TableCell>
                      <TableCell className="font-mono text-emerald-600 font-medium">{m.busyTime} mins</TableCell>
                      <TableCell className="font-mono text-muted-foreground">{m.idleTime} mins</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="w-24 bg-muted rounded-full h-2 overflow-hidden">
                            <div className="bg-primary h-full rounded-full" style={{ width: `${Math.min(100, m.utilizationPercentage)}%` }} />
                          </div>
                          <span className="font-bold text-xs">{m.utilizationPercentage.toFixed(1)}%</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Download XLSX Action Component
 */
function PlanActions({
  plan,
  insights,
  allMachines,
  formatTime,
}: {
  plan: ProductionPlan;
  insights: PlanInsights | null;
  shiftDuration: number;
  allMachines: Machine[];
  formatTime: (minutes: number) => string;
}) {
  const [isGenerating, setIsGenerating] = useState(false);

  const handleDownloadXlsx = async () => {
    if (!plan || !plan.productionPlan) return;
    setIsGenerating(true);

    try {
      const wb = XLSX.utils.book_new();

      // Detailed Schedule Sheet
      const scheduleData = plan.productionPlan.map(item => ({
        "Execution Order": item.executionOrder || 1,
        "Part Name": item.partName,
        "Operation": item.operationName,
        "Task Type": item.taskType,
        "Machine": item.machineName,
        "Quantity": item.taskType === 'Production' ? item.quantity : 0,
        "Start Time": formatTime(item.startTime),
        "End Time": formatTime(item.endTime),
        "Duration (min)": item.endTime - item.startTime,
      }));

      const scheduleSheet = XLSX.utils.json_to_sheet(scheduleData);
      XLSX.utils.book_append_sheet(wb, scheduleSheet, "Production Schedule");

      // Save workbook
      const today = new Date().toISOString().split('T')[0];
      XLSX.writeFile(wb, `${today}_Production_Plan.xlsx`);
    } catch (e) {
      console.error("XLSX export error", e);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleDownloadXlsx} disabled={isGenerating}>
      <Download className="mr-2 h-4 w-4" />
      {isGenerating ? "Exporting..." : "Export XLSX"}
    </Button>
  );
}

function PlanDisplaySkeleton() {
  return (
    <Card className="p-6">
      <Skeleton className="h-8 w-1/3 mb-4" />
      <div className="grid grid-cols-4 gap-4 mb-6">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-64 w-full" />
    </Card>
  );
}
