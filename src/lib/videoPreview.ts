/**
 * Utility to calculate preview start offset for Episode 1 when no trailer is present.
 * If trailer is missing, it starts episode 1 from 5-10 minutes / mid point (300 - 600s).
 */
export const calculateEpisodeStartSeconds = (durationSeconds?: number): number => {
  if (!durationSeconds || durationSeconds <= 0) {
    // Default to 5 minutes (300 seconds)
    return 300;
  }

  const mid = Math.floor(durationSeconds / 2);

  // For shorter episodes (< 10 mins / 600s), start at 30% into the episode
  if (durationSeconds < 600) {
    return Math.max(30, Math.floor(durationSeconds * 0.3));
  }

  // If the middle falls between 5 and 10 minutes (300s to 600s), use mid!
  // e.g. 12-min episode -> 360s (6 mins)
  // e.g. 15-min episode -> 450s (7.5 mins)
  // e.g. 18-min episode -> 540s (9 mins)
  // e.g. 20-min episode -> 600s (10 mins)
  if (mid >= 300 && mid <= 600) {
    return mid;
  }

  // For longer episodes (> 20 mins where mid > 10 mins), start at 300s (5 minutes in)
  // to skip opening credits and start right in the action
  return 300;
};
