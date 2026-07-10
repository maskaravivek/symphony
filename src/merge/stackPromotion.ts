export function resolvePromotedBase(
  currentBase: string,
  mergedPullRequests: Array<{ head_ref: string; base_ref: string }>,
): string {
  const mergedByHead = new Map(mergedPullRequests.map((pr) => [pr.head_ref, pr.base_ref]));
  let nextBase = currentBase;
  const visited = new Set<string>();
  while (mergedByHead.has(nextBase) && !visited.has(nextBase)) {
    visited.add(nextBase);
    nextBase = mergedByHead.get(nextBase)!;
  }
  return nextBase;
}
