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

export type WebsitePlanPeriod = {
  /** Text after the price slash: "Month", "3 Months", "6 Months", "Year". */
  suffix: string;
  /** Unit only, plural when the count is not 1: "Month", "Months", "Year". */
  unit: string;
  /** Count shown in "Valid for N Unit". 12 months is 1 year. */
  count: number;
};

/**
 * Labels for the website plan modal.
 * The modal prints `plan.duration` after the price and
 * `plan.durationValue + plan.duration` in "Valid for …".
 * One month stays "Month" and one year stays "Year" (no leading 1).
 * Longer periods include the count: "3 Months", "6 Months".
 */
export function websitePlanPeriod(duration: string, durationValue: number): WebsitePlanPeriod {
  const normalized = String(duration || 'Month').trim().toLowerCase();
  let count = Math.max(1, Math.trunc(Number(durationValue) || 1));
  const embedded = normalized.match(/(\d+)\s*-?\s*(day|week|month|year)/);
  if (embedded && count === 1) count = parseInt(embedded[1], 10);
  if (normalized.includes('month') && count >= 28 && count <= 31 && !embedded) count = 1;

  let kind: 'day' | 'week' | 'month' | 'year' = 'month';
  if (normalized.includes('day')) kind = 'day';
  else if (normalized.includes('week')) kind = 'week';
  else if (normalized.includes('year') || normalized.includes('annual')) kind = 'year';
  else if (count === 12) kind = 'year';

  if (kind === 'year' && !normalized.includes('year') && !normalized.includes('annual')) count = 1;

  const singular = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' }[kind];
  const plural = { day: 'Days', week: 'Weeks', month: 'Months', year: 'Years' }[kind];
  const unit = count === 1 ? singular : plural;
  const suffix = count === 1 ? singular : `${count} ${plural}`;
  return { suffix, unit, count };
}
