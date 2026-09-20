/** "just now", "12 min ago", "3 h ago", "2 d ago" */
export function formatAge(ageSec: number): string {
  const s = Math.max(0, Math.round(ageSec));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
