export interface IntakeRepository {
  id: string;
  repository: string;
  aliases?: string[];
}

const aliasesByRepository: Record<string, string[]> = {
  'pdfkit.app': ['pdfkit'],
  'ai-photographer': ['camera coach'],
  myaarti: ['aarti'],
  freecalculator: ['calculator'],
};

export function intakeAliases(repository: string): string[] {
  return aliasesByRepository[repository.split('/').at(-1)!.toLowerCase()] ?? [];
}

function names(repo: IntakeRepository): string[] {
  return [...new Set([repo.id, repo.repository.split('/').at(-1)!, ...(repo.aliases ?? [])].map(name => name.toLowerCase()))];
}

type Resolution = { kind: 'matched'; repo: IntakeRepository; text: string }
  | { kind: 'ambiguous'; ids: string[] }
  | { kind: 'unknown' | 'invalid' };

export function resolveIntake(input: string, repos: IntakeRepository[]): Resolution {
  const args = input.trim();
  if (!args) return { kind: 'invalid' };
  const lower = args.toLowerCase();
  // Prefer the longest complete name, so "camera coach" needs no quotes and
  // neither word leaks into the issue body. Exact names beat substring matches.
  const exact = repos.flatMap(repo => names(repo)
    .filter(name => lower === name || (lower.startsWith(name) && /\s/.test(lower[name.length]!)))
    .map(name => ({ repo, length: name.length })));
  const longest = Math.max(0, ...exact.map(match => match.length));
  const selector = args.match(/^\S+/)![0];
  const candidates = longest
    ? exact.filter(match => match.length === longest).map(match => match.repo)
    : repos.filter(repo => names(repo).some(name => name.includes(selector.toLowerCase())));
  const unique = [...new Map(candidates.map(repo => [repo.id, repo])).values()];
  if (!unique.length) return { kind: 'unknown' };
  if (unique.length > 1) return { kind: 'ambiguous', ids: unique.map(repo => repo.id) };
  const text = args.slice(longest || selector.length).trim();
  return text ? { kind: 'matched', repo: unique[0]!, text } : { kind: 'invalid' };
}
