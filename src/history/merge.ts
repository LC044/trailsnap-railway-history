import { versionHash, type TrainHistoryEntry, type TrainVersion } from "./store";

export function mergeTrain(entry: TrainHistoryEntry, incoming: TrainVersion, date: string) {
  // A -> B -> A retains both contents and exact observed operating days.
  const existing = entry.versions.find(v => v.h === incoming.h);
  if (existing) {
    existing.dates = [...new Set([...(existing.dates ?? [existing.fd, existing.ld]), date])].sort();
    existing.fd = existing.dates[0];
    existing.ld = existing.dates.at(-1)!;
    existing.observed_at = incoming.observed_at;
  } else entry.versions.push({ ...incoming, fd: date, ld: date, dates: [date] });
}

export function makeVersion(no: string, from: string, to: string, stops: TrainVersion["s"], date: string, raw: unknown): TrainVersion {
  return {no, f: from, t: to, s: stops, fd: date, ld: date, h: versionHash(no, from, to, stops),
    raw, observed_at: new Date().toISOString(), dates: [date]};
}
