/**
 * Billing-period labels for the existing Android app.
 *
 * Plans are stored as a unit (`Month`, `Months`, `Year`, …) plus `durationValue`
 * (1, 3, 6, 12). The app reads `duration` and treats every month-unit string
 * ("Month" and "Months") as "/monthly", so a 3-month, 6-month, or 12-month
 * plan never leaves the monthly label. These fields are the strings that
 * label actually switches on.
 */
export type PlanPeriodFields = {
  duration: string;
  durationLabel: string;
  billingPeriod: string;
  period: string;
  periodLabel: string;
  planDuration: string;
  packageDuration: string;
  plan_duration: string;
  package_duration: string;
  validity: string;
  type: string;
  durationType: string;
  duration_type: string;
  time: string;
  package_time: string;
  durationUnit: string;
  durationValue: number;
  duration_value: number;
  months: number;
};

const cleanUnit = (duration: string) => String(duration || 'Month').trim();

export function describePlanPeriod(duration: string, durationValue: number): PlanPeriodFields {
  const durationUnit = cleanUnit(duration);
  const normalized = durationUnit.toLowerCase();
  let value = Math.max(1, Math.trunc(Number(durationValue) || 1));

  // "3 Months" stuffed into the unit string while durationValue stayed 1.
  const embeddedMonths = normalized.match(/(\d+)\s*-?\s*months?/);
  if (embeddedMonths && !normalized.includes('year')) {
    const embedded = parseInt(embeddedMonths[1], 10);
    if (embedded > 1 && value === 1) value = embedded;
  }

  // Same mis-save the subscription writer already treats as 1 month:
  // unit Monthly + durationValue 30 (days / price), not thirty months.
  if (normalized.includes('month') && value >= 28 && value <= 31 && !embeddedMonths) {
    value = 1;
  }

  let months = 0;
  let label = 'monthly';

  if (normalized.includes('day')) {
    label = value === 1 ? 'daily' : `${value} days`;
  } else if (normalized.includes('week')) {
    label = value === 1 ? 'weekly' : `${value} weeks`;
  } else if (normalized.includes('year') || normalized.includes('annual')) {
    months = value * 12;
    label = value === 1 ? 'yearly' : `${value} years`;
  } else {
    months = value === 12 ? 12 : value;
    if (value === 12) label = 'yearly';
    else if (value === 1) label = 'monthly';
    else label = `${value} months`;
  }

  return {
    duration: label,
    durationLabel: label,
    billingPeriod: label,
    period: label,
    periodLabel: label,
    planDuration: label,
    packageDuration: label,
    plan_duration: label,
    package_duration: label,
    validity: label,
    type: label,
    durationType: label,
    duration_type: label,
    time: label,
    package_time: label,
    durationUnit,
    durationValue: Math.max(1, Math.trunc(Number(durationValue) || 1)),
    duration_value: Math.max(1, Math.trunc(Number(durationValue) || 1)),
    months,
  };
}
